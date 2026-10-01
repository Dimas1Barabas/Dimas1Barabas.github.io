/**
 * Событийный контур против живого RabbitMQ (testcontainers): публикация
 * уходит в реальный exchange, вердикты Go-воркера едут в реальные очереди
 * и обрабатываются настоящими @RabbitSubscribe-консьюмерами приложения.
 *
 * Воркера (ticket-worker) не поднимаем — его роль в этом спеке играет
 * тест: публикует booking.processed / booking.expired в exchange «cinema»
 * как это делает воркер. Ределивери проверяем повторной публикацией —
 * обработчики обязаны остаться идемпотентными.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describeLive, buildLiveApp, liveInfra, type LiveAppContext } from './live-harness';
import type * as amqp from 'amqplib';

describeLive('CineBooking API: события через живой RabbitMQ (testcontainers)', () => {
  let h: LiveAppContext;
  let conn: amqp.ChannelModel;
  let ch: amqp.Channel;

  beforeAll(async () => {
    h = await buildLiveApp();
    conn = await (await import('amqplib')).connect((await liveInfra()).amqpUrl);
    ch = await conn.createChannel();
  }, 240_000);

  afterAll(async () => {
    await conn?.close();
    await h?.app.close();
  });

  /** создать+оплатить бронь: ready к вердикту воркера */
  async function paidBooking(seat: string): Promise<{ id: string; totalRub: number; sessionId: string }> {
    const movies = await h.catalog();
    const session = movies[0].sessions[0];
    const created = await request(h.app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', h.bearer)
      .send({ sessionId: session.id, customerName: 'Дмитрий', seats: [seat] });
    expect(created.status).toBe(201);
    const paid = await request(h.app.getHttpServer())
      .post(`/api/bookings/${created.body.id}/pay`)
      .set('Authorization', h.bearer);
    expect(paid.status).toBe(200);
    return { id: created.body.id, totalRub: paid.body.totalRub, sessionId: session.id };
  }

  /** вердикт воркера — как публикует ticket-worker */
  function publishVerdict(routingKey: string, event: Record<string, unknown>): void {
    ch.publish('cinema', routingKey, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json',
      persistent: true,
    });
  }

  /** get с narrow: пустая очередь — ошибка теста, а не NPE */
  async function getOne(queue: string): Promise<amqp.Message> {
    const msg = await ch.get(queue);
    if (!msg) throw new Error(`очередь ${queue} пуста — событие не опубликовано`);
    return msg;
  }

  it('wait-событие резерва реально лежит в wait-очереди брокера', async () => {
    const movies = await h.catalog();
    const session = movies[0].sessions[0];
    const created = await request(h.app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', h.bearer)
      .send({ sessionId: session.id, customerName: 'Дмитрий', seats: ['6-1'] });
    expect(created.status).toBe(201);

    const msg = await getOne('booking.payment.wait');
    const body = JSON.parse(msg.content.toString());
    expect(body).toMatchObject({
      bookingId: created.body.id,
      sessionId: session.id,
      seatsCount: 1,
      totalRub: created.body.totalRub,
    });
    expect(typeof body.expiresAt).toBe('string');
    ch.ack(msg);
  });

  it('оплата публикует booking.created в exchange — ловим живую маршрутизацию', async () => {
    // воркера нет: временную очередь биндим сами, как это сделал бы воркер
    const q = await ch.assertQueue('', { exclusive: true });
    ch.bindQueue(q.queue, 'cinema', 'booking.created');

    const booking = await paidBooking('6-2');

    const msg = await getOne(q.queue);
    const body = JSON.parse(msg.content.toString());
    expect(body).toMatchObject({
      bookingId: booking.id,
      sessionId: booking.sessionId,
      seats: ['6-2'],
      totalRub: booking.totalRub,
      customerName: 'Дмитрий',
    });
    ch.ack(msg);
    ch.deleteQueue(q.queue);
  });

  it('вердикт booking.processed: реальный консьюмер подтверждает бронь и пишет кэшбэк', async () => {
    const booking = await paidBooking('6-3');

    publishVerdict('booking.processed', {
      bookingId: booking.id,
      status: 'CONFIRMED',
      message: 'Билеты оформлены',
      processedBy: 'live-int',
      processedAt: new Date().toISOString(),
    });

    const done = await h.waitBookingStatus(booking.id, ['CONFIRMED']);
    expect(done.status).toBe('CONFIRMED');
    expect(done.processedBy).toBe('live-int');

    // кэшбэк начислен настоящим INSERT … ON CONFLICT в живом ledger
    const [row] = await h.db.query<{ amount: number }[]>(
      `SELECT amount FROM bonus_transactions
       WHERE booking_id = $1 AND kind = 'accrual' AND reason = 'cashback'`,
      [booking.id],
    );
    expect(row).toBeTruthy();
    expect(Number(row.amount)).toBeGreaterThan(0);

    const account = await request(h.app.getHttpServer())
      .get('/api/bonuses/my')
      .set('Authorization', h.bearer);
    expect(account.body.balance).toBe(Number(row.amount));
  });

  it('ределивери вердикта идемпотентен: кэшбэк не задваивается', async () => {
    const booking = await paidBooking('6-4');
    const verdict = {
      bookingId: booking.id,
      status: 'CONFIRMED',
      message: 'Билеты оформлены',
      processedBy: 'live-int',
      processedAt: new Date().toISOString(),
    };
    publishVerdict('booking.processed', verdict);
    await h.waitBookingStatus(booking.id, ['CONFIRMED']);

    // брокер переиграл сообщение: дубль вердикта по уже закрытой брони
    publishVerdict('booking.processed', verdict);
    await new Promise((r) => setTimeout(r, 1500)); // даём консьюмеру отработать дубль
    await h.waitBookingStatus(booking.id, ['CONFIRMED']);

    const rows = await h.db.query<{ reason: string }[]>(
      `SELECT reason FROM bonus_transactions WHERE booking_id = $1 AND reason = 'cashback'`,
      [booking.id],
    );
    expect(rows).toHaveLength(1);

    const account = await request(h.app.getHttpServer())
      .get('/api/bonuses/my')
      .set('Authorization', h.bearer);
    // один кэшбэк с 6-3 и один с 6-4 — дубль не добавил
    const cashbacks = await h.db.query<{ sum: string }[]>(
      `SELECT coalesce(sum(amount), 0) AS sum FROM bonus_transactions
       WHERE user_id = (SELECT id FROM users WHERE email = 'a@live.test') AND kind = 'accrual'`,
    );
    expect(account.body.balance).toBe(Number(cashbacks[0].sum));
  });

  it('вердикт booking.expired гасит неоплаченную бронь и возвращает место в продажу', async () => {
    const movies = await h.catalog();
    const session = movies[0].sessions[0];
    const created = await request(h.app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', h.bearer)
      .send({ sessionId: session.id, customerName: 'Дмитрий', seats: ['7-7'] });
    expect(created.status).toBe(201);

    publishVerdict('booking.expired', {
      bookingId: created.body.id,
      message: 'Окно оплаты истекло',
      processedBy: 'live-int',
      expiredAt: new Date().toISOString(),
    });

    const done = await h.waitBookingStatus(created.body.id, ['EXPIRED']);
    expect(done.status).toBe('EXPIRED');

    // место снова в продаже — живой DELETE занятости
    const map = await request(h.app.getHttpServer())
      .get(`/api/sessions/${session.id}/seats`);
    expect(map.body.occupied).not.toContain('7-7');

    // повторный expired (ределивери) не трогает уже закрытую бронь
    publishVerdict('booking.expired', {
      bookingId: created.body.id,
      message: 'Окно оплаты истекло',
      processedBy: 'live-int',
      expiredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 1000));
    await h.waitBookingStatus(created.body.id, ['EXPIRED']);
    const mapAgain = await request(h.app.getHttpServer())
      .get(`/api/sessions/${session.id}/seats`);
    expect(mapAgain.body.occupied).not.toContain('7-7');
  });

  it('мусор в очереди не роняет цикл: чужое событие игнорируется, соседняя бронь живёт', async () => {
    const booking = await paidBooking('8-8');

    // событие о несуществующей брони: errorHandler не должен уронить консьюмера
    publishVerdict('booking.processed', {
      bookingId: randomUUID(),
      status: 'CONFIRMED',
      message: 'нет такой брони',
      processedBy: 'live-int',
      processedAt: new Date().toISOString(),
    });

    publishVerdict('booking.processed', {
      bookingId: booking.id,
      status: 'CONFIRMED',
      message: 'Билеты оформлены',
      processedBy: 'live-int',
      processedAt: new Date().toISOString(),
    });
    await h.waitBookingStatus(booking.id, ['CONFIRMED']);
  });
});
