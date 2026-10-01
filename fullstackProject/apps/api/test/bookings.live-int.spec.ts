/**
 * Жизненный цикл брони против настоящей инфраструктуры: Postgres с
 * миграциями, констрейнтами и каскадами, Redis, RabbitMQ — всё живое
 * (testcontainers, TESTCONTAINERS=1; см. ./live-harness). От int-спеков
 * отличается уровнем честности: гонку за место решает реальный
 * uq seat_occupancy, активацию промокода — реальный UPDATE … RETURNING,
 * статистику — реальный GROUP BY, бонусы — реальный SUM по ledger.
 *
 * Вердикты Go-воркера (booking.processed) здесь не приезжают —
 * это реальный брокер без воркера; их гоняет rabbitmq.live-int.
 */
import request from 'supertest';
import { describeLive, buildLiveApp, type LiveAppContext, type MovieDtoJson } from './live-harness';

describeLive('CineBooking API: бронь против живого Postgres (testcontainers)', () => {
  let h: LiveAppContext;

  beforeAll(async () => {
    h = await buildLiveApp();
  }, 240_000);

  afterAll(async () => {
    await h.app.close();
  });

  it('boot-путь прод-старта: миграции применились, каталог посеян', async () => {
    // buildLiveApp уже прогнал migrationsRun и посев; сверяем результат
    const applied: { name: string }[] = await h.db.query(
      'SELECT name FROM migrations ORDER BY timestamp',
    );
    expect(applied.length).toBeGreaterThanOrEqual(9);
    expect(applied[0].name).toBe('InitialSchema');

    const movies = await h.catalog();
    expect(movies.length).toBeGreaterThan(0);
    for (const m of movies) {
      expect(m.sessions.length).toBeGreaterThan(0);
    }
  });

  it('гонка двух брони за одно место: uq-констрейнт оставляет одному 201, другому 409', async () => {
    const [movie, session] = await sessionOf();
    const seat = '1-1';

    const [first, second] = await Promise.all([
      post(h.bearer, session.id, 'Первый', [seat]),
      post(h.bearerB, session.id, 'Второй', [seat]),
    ]);
    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([201, 409]);

    // в живой базе — ровно одна строка занятости на место
    const rows: { count: string }[] = await h.db.query(
      'SELECT count(*) FROM seat_occupancy WHERE session_id = $1 AND seat = $2',
      [session.id, seat],
    );
    expect(Number(rows[0].count)).toBe(1);

    // карта зала видит место занятым
    const map = await request(h.app.getHttpServer())
      .get(`/api/sessions/${session.id}/seats`);
    expect(map.status).toBe(200);
    expect(map.body.occupied).toContain(seat);

    // одна бронь ждёт оплаты, статистика это подтверждает (живой GROUP BY)
    const stats = await request(h.app.getHttpServer()).get('/api/bookings/stats');
    expect(stats.body.PENDING_PAYMENT).toBe(1);

    void movie;
  });

  it('оплата с промокодом: атомарная активация списывает запас и пишет скидку в бронь', async () => {
    const [, session] = await sessionOf();
    // промокод сеем напрямую — админского эндпоинта для них нет
    await h.db.query(
      `INSERT INTO promos (code, kind, value, max_activations, used_count, expires_at, created_at)
       VALUES ('LIVE500', 'fixed', 500, 1, 0, now() + interval '1 day', now())`,
    );

    const created = await post(h.bearer, session.id, 'Дмитрий', ['2-2']);
    expect(created.status).toBe(201);
    const totalBefore: number = created.body.totalRub;
    expect(totalBefore).toBeGreaterThan(500);

    const paid = await request(h.app.getHttpServer())
      .post(`/api/bookings/${created.body.id}/pay`)
      .set('Authorization', h.bearer)
      .send({ promoCode: 'live500' });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PENDING');
    expect(paid.body.totalRub).toBe(totalBefore - 500);
    expect(paid.body.promoCode).toBe('LIVE500');
    expect(paid.body.discountRub).toBe(500);

    // запас исчерпан живым UPDATE: повторная активация невозможна
    const [promo] = await h.db.query<{ used_count: number }[]>(
      'SELECT used_count FROM promos WHERE code = $1',
      ['LIVE500'],
    );
    expect(Number(promo.used_count)).toBe(1);

    const second = await post(h.bearer, session.id, 'Ещё Раз', ['2-3']);
    const refused = await request(h.app.getHttpServer())
      .post(`/api/bookings/${second.body.id}/pay`)
      .set('Authorization', h.bearer)
      .send({ promoCode: 'live500' });
    expect(refused.status).toBe(409);
  });

  it('оплата бонусами: spend-строка в ledger и баланс из живого SUM', async () => {
    const [, session] = await sessionOf();
    const created = await post(h.bearer, session.id, 'Дмитрий', ['3-3']);
    const total: number = created.body.totalRub;
    const userId: string = (
      await h.db.query<{ id: string }[]>('SELECT id FROM users WHERE email = $1', ['a@live.test'])
    )[0].id;
    // стартовый баланс сеем напрямую в ledger; booking_id обязан быть
    // существующей бронью (FK), welcome и payment — разные reason, uq не мешает
    const seed = Math.floor(total / 2);
    await h.db.query(
      `INSERT INTO bonus_transactions (user_id, booking_id, kind, reason, amount, created_at)
       VALUES ($1, $2, 'accrual', 'welcome', $3, now())`,
      [userId, created.body.id, seed],
    );

    const paid = await request(h.app.getHttpServer())
      .post(`/api/bookings/${created.body.id}/pay`)
      .set('Authorization', h.bearer)
      .send({ useBonuses: seed });
    expect(paid.status).toBe(200);
    expect(paid.body.totalRub).toBe(total - seed);
    expect(paid.body.bonusSpent).toBe(seed);

    // личный кабинет: spend-строка живёт в ledger, баланс обнулился
    const account = await request(h.app.getHttpServer())
      .get('/api/bonuses/my')
      .set('Authorization', h.bearer);
    expect(account.status).toBe(200);
    expect(account.body.balance).toBe(0);
    const spend = account.body.transactions.find(
      (t: { reason: string; kind: string }) => t.reason === 'payment' && t.kind === 'spend',
    );
    expect(spend.amount).toBe(seed);
  });

  it('лимит «бонусами не больше половины чека» считается от живой суммы брони', async () => {
    const [, session] = await sessionOf();
    const created = await post(h.bearer, session.id, 'Дмитрий', ['4-4']);
    const total: number = created.body.totalRub;

    const over = await request(h.app.getHttpServer())
      .post(`/api/bookings/${created.body.id}/pay`)
      .set('Authorization', h.bearer)
      .send({ useBonuses: Math.floor(total / 2) + 10 });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('bonusOverLimit');
  });

  it('личный кабинет изолирует брони по живому user_id', async () => {
    const [, session] = await sessionOf();
    const mine = await post(h.bearer, session.id, 'Анна', ['5-5']);
    const theirs = await post(h.bearerB, session.id, 'Борис', ['5-6']);
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);

    const a = await request(h.app.getHttpServer())
      .get('/api/bookings/my')
      .set('Authorization', h.bearer);
    const ids = a.body.map((b: { id: string }) => b.id);
    expect(ids).toContain(mine.body.id);
    expect(ids).not.toContain(theirs.body.id);
  });

  /** первый сеанс первого фильма каталога */
  async function sessionOf(): Promise<[MovieDtoJson, MovieDtoJson['sessions'][number]]> {
    const movies = await h.catalog();
    const movie = movies[0];
    return [movie, movie.sessions[0]];
  }

  function post(bearer: string, sessionId: string, name: string, seats: string[]) {
    return request(h.app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', bearer)
      .send({ sessionId, customerName: name, seats });
  }
});
