/**
 * HTTP-int уровень внешних метаданных (этап 37): роутинг + гварды на
 * эндпоинтах синка и статуса, декорирование каталога поверх ответа
 * MoviesService. Сервис за фейком харнесса (Map строк) — контракты
 * настоящего EnrichmentService и resilience-клиента закрыты юнитами,
 * живой SQL/HTTP — live-int и e2e со стеном.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildHttpIntApp, validUuid } from './int-harness';

describe('CineBooking API: внешние метаданные афиши (фейк-справочник)', () => {
  let app: INestApplication;
  let bearer: string;
  let bearerAdmin: string;
  let movieId: string;

  beforeAll(async () => {
    const h = await buildHttpIntApp();
    app = h.app;
    bearer = h.bearer;
    bearerAdmin = h.bearerAdmin;
    const movies = await request(app.getHttpServer()).get('/api/movies');
    movieId = movies.body.data[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/movies/:id/external-sync (админ)', () => {
    it('401 без токена, 403 обычному пользователю', async () => {
      const anon = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/external-sync`);
      expect(anon.status).toBe(401);

      const user = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/external-sync`)
        .set('Authorization', bearer);
      expect(user.status).toBe(403);
    });

    it('400 не-uuid, 404 несуществующего фильма', async () => {
      const bad = await request(app.getHttpServer())
        .post('/api/movies/not-a-uuid/external-sync')
        .set('Authorization', bearerAdmin);
      expect(bad.status).toBe(400);

      const missing = await request(app.getHttpServer())
        .post(`/api/movies/${validUuid()}/external-sync`)
        .set('Authorization', bearerAdmin);
      expect(missing.status).toBe(404);
    });

    it('200 админу: результат синка телом', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/external-sync`)
        .set('Authorization', bearerAdmin);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        movieId,
        matched: true,
        posterSynced: false,
      });
      expect(res.body.external).toMatchObject({ rating: 8.3, year: 2025 });
    });
  });

  describe('GET /api/movies — декорирование каталога', () => {
    it('синкнутый фильм несёт external, остальные — без поля', async () => {
      const res = await request(app.getHttpServer()).get('/api/movies');
      expect(res.status).toBe(200);
      const withExternal = res.body.data.filter((m: { external?: unknown }) => m.external);
      expect(withExternal.length).toBe(1); // синкнули ровно один
      expect(withExternal[0].id).toBe(movieId);
      // у остальных поля нет вовсе — не null
      const rest = res.body.data.filter((m: { external?: unknown }) => !m.external);
      for (const m of rest) expect(m).not.toHaveProperty('external');
    });

    it('карточка по id тоже с внешним блоком', async () => {
      const res = await request(app.getHttpServer()).get(`/api/movies/${movieId}`);
      expect(res.status).toBe(200);
      expect(res.body.external).toMatchObject({ rating: 8.3 });
    });
  });

  describe('GET /api/admin/external-movies/status (админ)', () => {
    it('401/403 не-админам, админу — витрина состояния', async () => {
      expect(
        (await request(app.getHttpServer()).get('/api/admin/external-movies/status')).status,
      ).toBe(401);
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/admin/external-movies/status')
            .set('Authorization', bearer)
        ).status,
      ).toBe(403);

      const res = await request(app.getHttpServer())
        .get('/api/admin/external-movies/status')
        .set('Authorization', bearerAdmin);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enabled: true,
        breaker: { state: 'closed', failures: 0 },
        enrichedMovies: 1,
      });
    });
  });
});
