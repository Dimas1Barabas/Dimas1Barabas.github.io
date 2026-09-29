/**
 * Каталог и доступ: витрина фильмов с Redis-кэшем, JWT-гвард на мутациях,
 * роли @Roles(admin) на создании фильмов, health. Вырезано из большого
 * http.int.spec.ts; бутстрап и фейки — в ./int-harness.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { buildHttpIntApp, requestCatalog, validUuid, type MovieDtoJson } from './int-harness';

describe('CineBooking API: каталог и доступ (фейковые зависимости)', () => {
  let app: INestApplication;
  let bookingsService: BookingsService;
  let redisStore: Map<string, string>;
  /** Authorization: владелец брони, чужак и администратор */
  let bearer: string;
  let bearerB: string;
  let bearerAdmin: string;

  let catalog: () => Promise<MovieDtoJson[]>;

  beforeAll(async () => {
    const h = await buildHttpIntApp();
    app = h.app;
    bookingsService = h.bookingsService;
    redisStore = h.redisStore;
    bearer = h.bearer;
    bearerB = h.bearerB;
    bearerAdmin = h.bearerAdmin;
    catalog = () => requestCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/movies', () => {
    it('первый вызов — из «БД», с посевом 6 фильмов и сеансами', async () => {
      const res = await request(app.getHttpServer()).get('/api/movies');

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('db');
      expect(res.body.data).toHaveLength(6);
      expect(res.body.data[0]).toMatchObject({
        title: expect.any(String),
        priceRub: expect.any(Number),
        sessions: expect.any(Array),
      });
      // sessionAt у фильма больше нет — время живёт в сеансах
      expect(res.body.data[0].sessionAt).toBeUndefined();
      expect(res.body.data[0].sessions.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data[0].sessions[0]).toMatchObject({
        id: expect.any(String),
        hall: expect.any(String),
        startsAt: expect.any(String),
      });
    });

    it('афиша отсортирована по ближайшему сеансу', async () => {
      const data = await catalog();
      // ближайший БУДУЩИЙ сеанс: прошедшие в конце дня уже не считаются
      const now = Date.now();
      const nearest = (m: MovieDtoJson) =>
        Math.min(
          ...m.sessions
            .map((s) => new Date(s.startsAt).getTime())
            .filter((t) => t >= now),
        );
      expect(nearest(data[0])).toBeLessThanOrEqual(nearest(data[1]));
    });

    it('повторный — из Redis-кэша (Map-фейк)', async () => {
      const res = await request(app.getHttpServer()).get('/api/movies');

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('cache');
      expect(redisStore.has('movies:all:v3')).toBe(true);
    });
  });

  describe('авторизация: Bearer-JWT на мутациях', () => {
    it('401: POST /api/bookings без токена', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .send({ sessionId: validUuid(), seats: ['1-1'] });

      expect(res.status).toBe(401);
    });

    it('401: мусорный токен', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', 'Bearer not-a-jwt')
        .send({ sessionId: validUuid(), seats: ['1-1'] });

      expect(res.status).toBe(401);
    });

    it('имя покупателя из JWT, когда customerName не передан', async () => {
      const movies = await catalog();
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: movies[5].sessions[0].id, seats: ['2-5'] });

      expect(res.status).toBe(201);
      expect(res.body.customerName).toBe('Анна Тест');
      expect(res.body.userId).toBe('user-a');
    });

    it('403: чужую бронь отменить нельзя', async () => {
      const movies = await catalog();
      const created = (
        await request(app.getHttpServer())
          .post('/api/bookings')
          .set('Authorization', bearer)
          .send({
            sessionId: movies[5].sessions[0].id,
            customerName: 'Владелец',
            seats: ['2-6'],
          })
      ).body;
      await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);
      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`)
        .set('Authorization', bearerB);

      expect(res.status).toBe(403);
    });

    it('витрина без токена открыта: movies, seats, stats, health', async () => {
      const movies = await catalog();
      expect(
        (await request(app.getHttpServer()).get('/api/movies')).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer()).get(
            `/api/sessions/${movies[0].sessions[0].id}/seats`,
          )
        ).status,
      ).toBe(200);
      expect(
        (await request(app.getHttpServer()).get('/api/bookings/stats')).status,
      ).toBe(200);
      expect(
        (await request(app.getHttpServer()).get('/api/health')).status,
      ).toBe(200);
    });
  });

  describe('админ: POST /api/movies (@Roles admin)', () => {
    const newMovie = {
      title: 'Тестовый сеанс',
      description: 'Фильм, созданный интеграционным тестом',
      genre: 'тест',
      genreIcon: '🧪',
      durationMin: 90,
      priceRub: 350,
      hue: 120,
      sessions: [
        { hall: 'IMAX', startsAt: '2026-12-31T23:00:00Z' },
        { hall: 'Красный', startsAt: '2027-01-01T13:00:00Z' },
      ],
    };

    it('401 без токена', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .send(newMovie);
      expect(res.status).toBe(401);
    });

    it('403 с токеном обычного пользователя', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearer)
        .send(newMovie);
      expect(res.status).toBe(403);
    });

    it('201 с админским токеном; сеансы создались, каталог обновился, кэш сброшен', async () => {
      // в общем файле кэш грели GET'ы других describe'ов; здесь греем сами —
      // иначе «сброс кэша» после create нечего было бы наблюдать
      await request(app.getHttpServer()).get('/api/movies');

      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearerAdmin)
        .send(newMovie);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ title: 'Тестовый сеанс', priceRub: 350 });
      expect(res.body.id).toBeTruthy();
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.sessions[0]).toMatchObject({ hall: 'IMAX' });

      // до создания кэш прогрет GET'ом выше; create его сбросил — список
      // читается из «БД» и содержит новинку
      const list = await request(app.getHttpServer()).get('/api/movies');
      expect(list.body.source).toBe('db');
      expect(
        list.body.data.some((m: { title: string }) => m.title === 'Тестовый сеанс'),
      ).toBe(true);
    });

    it('400 с кривыми данными (hue вне 0–360)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearerAdmin)
        .send({ ...newMovie, title: 'Кривой hue', hue: 999 });

      expect(res.status).toBe(400);
    });

    it('400 без единого сеанса', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearerAdmin)
        .send({ ...newMovie, title: 'Без сеансов', sessions: [] });

      expect(res.status).toBe(400);
    });

    it('400 с мусором вместо объекта сеанса (nested-валидация)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearerAdmin)
        .send({
          ...newMovie,
          title: 'Мусорный сеанс',
          sessions: [{ hall: 'IMAX', startsAt: 'завтра-в-семь' }],
        });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/health', () => {
    it('все фейки живы → ok', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks).toEqual({
        postgres: 'up',
        redis: 'up',
        rabbitmq: 'up',
      });
    });
  });
});
