/**
 * Бронь от создания до финала: POST /api/bookings с валидацией, изоляция
 * занятости между сеансами, гонки за места, вердикты Go-воркера, оплата,
 * истечение резерва, отмена неоплаченной, личный кабинет и SSE-поток.
 * Вырезано из большого http.int.spec.ts; бутстрап и фейки — в ./int-harness.
 *
 * Порядок describe'ов значим: «полный цикл» сверяет карту мест с бронями
 * из «POST /api/bookings» (5-7, 5-8) и «гонка за места» (4-4).
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import { BookingsService } from '../src/bookings/bookings.service';
import { buildHttpIntApp, requestCatalog, validUuid, FakeBookingRepo, type MovieDtoJson } from './int-harness';
import { sseFrames, waitForSseEvent } from './sse';

describe('CineBooking API: жизненный цикл брони (фейковые зависимости)', () => {
  let app: INestApplication;
  let bookingsService: BookingsService;
  let bookingsRepo: FakeBookingRepo;
  let rabbitPublish: jest.Mock;
  /** Authorization: владелец брони, чужак и администратор */
  let bearer: string;
  let bearerB: string;
  let bearerAdmin: string;

  let catalog: () => Promise<MovieDtoJson[]>;

  beforeAll(async () => {
    const h = await buildHttpIntApp();
    app = h.app;
    bookingsService = h.bookingsService;
    bookingsRepo = h.bookingsRepo;
    rabbitPublish = h.rabbitPublish;
    bearer = h.bearer;
    bearerB = h.bearerB;
    bearerAdmin = h.bearerAdmin;
    catalog = () => requestCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/bookings', () => {
    it('создаёт PENDING_PAYMENT-бронь с дедлайном и публикует wait-событие', async () => {
      const movies = await catalog();
      const movie = movies[0];
      const session = movie.sessions[0];

      rabbitPublish.mockClear();
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({
          sessionId: session.id,
          customerName: 'Дмитрий',
          seats: ['5-7', '5-8'],
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'PENDING_PAYMENT',
        seats: ['5-7', '5-8'],
        totalRub: movie.priceRub * 2,
        movieTitle: movie.title,
        sessionId: session.id,
        hall: session.hall,
        sessionAt: session.startsAt,
        customerName: 'Дмитрий',
      });
      // дедлайн оплаты — через стандартное окно
      expect(res.body.expiresAt).toBeTruthy();

      // таймер резерва: событие уходит «тикать» в wait-очередь
      expect(rabbitPublish).toHaveBeenCalledWith(
        'cinema',
        'booking.payment.wait',
        expect.objectContaining({
          bookingId: res.body.id,
          totalRub: movie.priceRub * 2,
        }),
      );
      expect(rabbitPublish).not.toHaveBeenCalledWith(
        'cinema',
        'booking.created',
        expect.anything(),
      );
    });

    it.each([
      ['мест больше 8', { sessionId: validUuid(), customerName: 'Дмитрий', seats: ['1-1','1-2','1-3','1-4','1-5','1-6','1-7','1-8','1-9'] }],
      ['пустой список мест', { sessionId: validUuid(), customerName: 'Дмитрий', seats: [] }],
      ['места не массив', { sessionId: validUuid(), customerName: 'Дмитрий', seats: 2 }],
      ['код не «ряд-место»', { sessionId: validUuid(), customerName: 'Дмитрий', seats: ['5'] }],
      ['место вне зала (ряд 9)', { sessionId: validUuid(), customerName: 'Дмитрий', seats: ['9-1'] }],
      ['место вне зала (место 11)', { sessionId: validUuid(), customerName: 'Дмитрий', seats: ['1-11'] }],
      ['имя из 1 символа', { sessionId: validUuid(), customerName: 'Д', seats: ['1-1'] }],
      ['не-uuid sessionId', { sessionId: 'abc', customerName: 'Дмитрий', seats: ['1-1'] }],
    ])('400 при невалидных данных: %s', async (_case, payload) => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send(payload);

      expect(res.status).toBe(400);
    });

    it('404 на несуществующий сеанс', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({
          sessionId: '00000000-0000-0000-0000-000000000000',
          customerName: 'Дмитрий',
          seats: ['1-1'],
        });

      expect(res.status).toBe(404);
    });
  });

  describe('изоляция занятости между сеансами', () => {
    it('одно место свободно в другом сеансе того же фильма', async () => {
      const movies = await catalog();
      const movie = movies[0];
      const [first, second] = movie.sessions;
      if (!second) throw new Error('в фикстуре должно быть ≥2 сеанса');

      const taken = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: first.id, customerName: 'Первый сеанс', seats: ['5-5'] });
      expect(taken.status).toBe(201);

      // то же место во втором сеансе — свободно
      const other = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: second.id, customerName: 'Второй сеанс', seats: ['5-5'] });
      expect(other.status).toBe(201);

      // но повторно в первом сеансе — конфликт
      const dup = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: first.id, customerName: 'Дубль', seats: ['5-5'] });
      expect(dup.status).toBe(409);
    });
  });

  describe('гонка за места: констрейнт (session_id, seat)', () => {
    it('409 со списком мест при повторном бронировании занятого', async () => {
      const movies = await catalog();
      const session = movies[0].sessions[0];

      const first = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: session.id, customerName: 'Первый', seats: ['4-4'] });
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({
          sessionId: session.id,
          customerName: 'Второй',
          seats: ['4-3', '4-4'],
        });

      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        statusCode: 409,
        seatsTaken: ['4-4'],
      });
      expect(second.body.message).toContain('4-4');
      // свободное место из отклонённой брони не занялось
      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toContain('4-4');
      expect(map.body.occupied).not.toContain('4-3');
    });

    it('GET /api/sessions/:id/seats — геометрия зала и счётчик свободных', async () => {
      const movies = await catalog();
      const session = movies[1].sessions[0];
      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);

      expect(map.status).toBe(200);
      expect(map.body.layout).toEqual({ rows: 8, seatsPerRow: 10 });
      expect(map.body.sessionId).toBe(session.id);
      expect(map.body.free + map.body.occupied.length).toBe(80);
    });

    it('GET /api/sessions/:id/seats — 404 на несуществующий сеанс', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sessions/00000000-0000-0000-0000-000000000000/seats');
      expect(res.status).toBe(404);
    });
  });

  describe('полный цикл брони: вердикт Go-воркера', () => {
    it('pay → handleProcessed → бронь становится CONFIRMED и видна в списке и статистике', async () => {
      const movies = await catalog();
      const session = movies[0].sessions[0];
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: session.id,
          customerName: 'Аноним',
          seats: ['6-1', '6-2', '6-3'],
        })
      ).body;

      // оплата переводит в PENDING — только теперь вердикт воркера применим
      const paid = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);
      expect(paid.status).toBe(200);
      expect(paid.body.status).toBe('PENDING');

      // то, что в реальном стеке делает Go ticket-worker через RabbitMQ
      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'CONFIRMED',
        message: 'Оплата прошла. Места 6-1, 6-2, 6-3.',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (
        await request(app.getHttpServer()).get('/api/bookings')
      ).body;
      const updated = list.find((b: { id: string }) => b.id === created.id);

      expect(updated.status).toBe('CONFIRMED');
      expect(updated.message).toContain('6-1');
      expect(updated.processedBy).toBe('go-worker-1');
      expect(updated.processedAt).toBeTruthy();

      // подтверждённая бронь держит места своего сеанса
      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toEqual(
        expect.arrayContaining(['6-1', '6-2', '6-3', '5-7', '5-8', '4-4']),
      );

      const stats = (
        await request(app.getHttpServer()).get('/api/bookings/stats')
      ).body;
      expect(stats.CONFIRMED).toBeGreaterThanOrEqual(1);
    });

    it('FAILED → места освобождаются, и их снова можно забронировать', async () => {
      const movies = await catalog();
      const session = movies[2].sessions[0];

      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: session.id,
          customerName: 'Отказ',
          seats: ['2-2'],
        })
      ).body;
      await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);

      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'FAILED',
        message: 'Платёж отклонён банком (код 42). Бронь отменена.',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).not.toContain('2-2');

      const rebook = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: session.id, customerName: 'Повтор', seats: ['2-2'] });
      expect(rebook.status).toBe(201);
    });
  });

  describe('оплата брони: POST /api/bookings/:id/pay', () => {
    /** свежая неоплаченная бронь — единая заготовка тестов блока */
    async function unpaidBooking(movieIdx: number, seats: string[]) {
      const movies = await catalog();
      const session = movies[movieIdx].sessions[0];
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: session.id, customerName: 'Плательщик', seats });
      expect(res.status).toBe(201);
      return { created: res.body, sessionId: session.id };
    }

    it('PENDING_PAYMENT → PENDING и публикует booking.created для воркера', async () => {
      const { created, sessionId } = await unpaidBooking(1, ['3-3']);

      rabbitPublish.mockClear();
      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PENDING');
      expect(rabbitPublish).toHaveBeenCalledTimes(1);
      expect(rabbitPublish).toHaveBeenCalledWith(
        'cinema',
        'booking.created',
        expect.objectContaining({
          bookingId: created.id,
          sessionId,
          seats: ['3-3'],
          totalRub: created.totalRub,
        }),
      );
    });

    it('повторная оплата → 409 с текущим статусом', async () => {
      const { created } = await unpaidBooking(1, ['3-4']);
      await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);

      const again = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);

      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ status: 'PENDING' });
    });

    it('403: чужую бронь оплатить нельзя', async () => {
      const { created } = await unpaidBooking(1, ['3-5']);

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearerB);

      expect(res.status).toBe(403);
    });

    it('401 без токена', async () => {
      const { created } = await unpaidBooking(1, ['3-6']);

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`);

      expect(res.status).toBe(401);
    });

    it('404 на несуществующую бронь', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings/00000000-0000-0000-0000-000000000009/pay')
        .set('Authorization', bearer);

      expect(res.status).toBe(404);
    });
  });

  describe('истечение резерва: booking.expired от Go-воркера', () => {
    it('гасит неоплаченную в EXPIRED — места свободны и снова покупаемы', async () => {
      const movies = await catalog();
      const session = movies[2].sessions[1] ?? movies[2].sessions[0];

      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: session.id,
          customerName: 'Забыл заплатить',
          seats: ['7-7'],
        })
      ).body;

      // то, что в реальном стеке делает Go ticket-worker по TTL wait-очереди
      await bookingsService.handleExpired({
        bookingId: created.id,
        message: 'Время оплаты истекло. Бронь отменена, места снова в продаже.',
        processedBy: 'go-worker-1',
        expiredAt: new Date().toISOString(),
      });

      const list = (await request(app.getHttpServer()).get('/api/bookings')).body;
      const expired = list.find((b: { id: string }) => b.id === created.id);
      expect(expired.status).toBe('EXPIRED');
      expect(expired.message).toContain('истекло');

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).not.toContain('7-7');

      const rebook = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: session.id, customerName: 'Успел', seats: ['7-7'] });
      expect(rebook.status).toBe(201);
    });

    it('просроченный таймер по оплаченной бронь — без последствий (гонка)', async () => {
      const movies = await catalog();
      const session = movies[3].sessions[0];
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: session.id,
          customerName: 'Успел впритык',
          seats: ['8-8'],
        })
      ).body;
      await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);

      await bookingsService.handleExpired({
        bookingId: created.id,
        message: 'Время оплаты истекло',
        processedBy: 'go-worker-1',
        expiredAt: new Date().toISOString(),
      });

      const list = (await request(app.getHttpServer()).get('/api/bookings')).body;
      const booking = list.find((b: { id: string }) => b.id === created.id);
      expect(booking.status).toBe('PENDING'); // не погасилась — платёж ушёл раньше

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toContain('8-8');
    });
  });

  describe('отмена неоплаченной брони', () => {
    it('PENDING_PAYMENT → CANCELLED сразу, места свободны, воркер не зовётся', async () => {
      const movies = await catalog();
      const session = movies[4].sessions[1] ?? movies[4].sessions[0];
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: session.id,
          customerName: 'Передумал',
          seats: ['4-9'],
        })
      ).body;

      rabbitPublish.mockClear();
      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`)
        .set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      // возвращать нечего — события booking.cancelled нет; места свободны —
      // лист ожидания узнаёт об этом событием
      expect(rabbitPublish).toHaveBeenCalledTimes(1);
      expect(rabbitPublish).toHaveBeenCalledWith(
        'cinema',
        'waitlist.seat.released',
        expect.objectContaining({ reason: 'CANCELLED_UNPAID', seats: ['4-9'] }),
      );

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).not.toContain('4-9');
    });
  });

  describe('личный кабинет: GET /api/bookings/my', () => {
    it('401 без токена', async () => {
      const res = await request(app.getHttpServer()).get('/api/bookings/my');

      expect(res.status).toBe(401);
    });

    it('показывает только брони владельца из токена', async () => {
      const movies = await catalog();
      const foreign = (
        await request(app.getHttpServer())
          .post('/api/bookings')
          .set('Authorization', bearerB)
          .send({ sessionId: movies[5].sessions[0].id, seats: ['3-1'] })
      ).body;
      expect(foreign.userId).toBe('user-b');

      const mine = await request(app.getHttpServer())
        .get('/api/bookings/my')
        .set('Authorization', bearer);
      const theirs = await request(app.getHttpServer())
        .get('/api/bookings/my')
        .set('Authorization', bearerB);

      expect(mine.status).toBe(200);
      expect(mine.body).toHaveLength(
        bookingsRepo.rows.filter((r) => r.userId === 'user-a').length,
      );
      expect(mine.body.every((b: { userId: string }) => b.userId === 'user-a')).toBe(true);
      expect(theirs.body).toHaveLength(1);
      expect(theirs.body[0]).toMatchObject({ id: foreign.id, userId: 'user-b' });
    });

    it('пусто у пользователя без броней', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/bookings/my')
        .set('Authorization', bearerAdmin);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('SSE: GET /api/bookings/stream', () => {
    /**
     * SSE — вечный ответ, supertest его не прочитает: поднимаем реальный
     * http-сервер на случайном порту и читаем фреймы из fetch-стрима.
     */
    it('событие booking прилетает при создании брони', async () => {
      await app.listen(0);
      const address = app.getHttpServer().address() as AddressInfo;
      const base = `http://127.0.0.1:${address.port}`;

      const controller = new AbortController();
      const res = await fetch(`${base}/api/bookings/stream`, {
        signal: controller.signal,
      });
      expect(res.ok).toBe(true);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const frames = sseFrames(res.body!);
      const movies = (
        (await (await fetch(`${base}/api/movies`)).json()) as {
          data: { sessions: { id: string }[] }[];
        }
      ).data;
      const created = (
        await (
          await fetch(`${base}/api/bookings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: bearer },
            body: JSON.stringify({
              sessionId: movies[1].sessions[0].id,
              customerName: 'SSE-клиент',
              seats: ['1-2'],
            }),
          })
        ).json()
      ) as { id: string; status: string };

      const payload = await waitForSseEvent<{
        booking: { id: string; status: string };
        stats: Record<string, number>;
      }>(frames, 'booking', (p) => p.booking.id === created.id);

      expect(payload.booking.status).toBe('PENDING_PAYMENT');
      expect(payload.booking.id).toBe(created.id);
      expect(payload.stats).toHaveProperty('PENDING_PAYMENT');
      expect(payload.stats).toHaveProperty('EXPIRED');

      controller.abort();
    });
  });
});
