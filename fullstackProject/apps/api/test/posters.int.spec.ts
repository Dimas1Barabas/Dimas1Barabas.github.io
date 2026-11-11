/**
 * Постеры фильмов (этап 29): GET /api/movies/:id/poster с кэш-заголовками
 * и 404-фолбэком, админские upload (multipart, белый список типов, 2 МБ) и
 * идемпотентный delete. S3 — мок-бакет из int-harness; живое хранилище —
 * уровень live-int (testcontainers) и e2e-стенда.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildHttpIntApp, validUuid } from './int-harness';

describe('CineBooking API: постеры фильмов (мок-S3)', () => {
  let app: INestApplication;
  let bearer: string;
  let bearerAdmin: string;
  let movieId: string;

  const png = (size = 16): Buffer =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(Math.max(0, size - 4), 7)]);

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

  describe('GET /api/movies/:id/poster', () => {
    it('нет постера — 404: витрина уходит на градиентный фолбэк', async () => {
      const res = await request(app.getHttpServer()).get(`/api/movies/${movieId}/poster`);

      expect(res.status).toBe(404);
    });

    it('несуществующий фильм — тоже 404 (uuid валиден, объекта нет)', async () => {
      const res = await request(app.getHttpServer()).get(`/api/movies/${validUuid()}/poster`);

      expect(res.status).toBe(404);
    });

    it('не-uuid id — 400 до всякого похода в хранилище', async () => {
      const res = await request(app.getHttpServer()).get('/api/movies/not-a-uuid/poster');

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/movies/:id/poster (админ, multipart)', () => {
    it('401 без токена, 403 обычному пользователю', async () => {
      const anon = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .attach('poster', png(), { filename: 'p.png', contentType: 'image/png' });
      expect(anon.status).toBe(401);

      const user = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .set('Authorization', bearer)
        .attach('poster', png(), { filename: 'p.png', contentType: 'image/png' });
      expect(user.status).toBe(403);
    });

    it('404 несуществующего фильма — до похода в S3', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/movies/${validUuid()}/poster`)
        .set('Authorization', bearerAdmin)
        .attach('poster', png(), { filename: 'p.png', contentType: 'image/png' });

      expect(res.status).toBe(404);
    });

    it('400 без файла, 415 не-изображению, 413 сверх 2 МБ', async () => {
      const noFile = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .set('Authorization', bearerAdmin)
        .field('dummy', 'x');
      expect(noFile.status).toBe(400);

      const wrongType = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .set('Authorization', bearerAdmin)
        .attach('poster', Buffer.from('plain text'), { filename: 'p.txt', contentType: 'text/plain' });
      expect(wrongType.status).toBe(415);

      const tooBig = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .set('Authorization', bearerAdmin)
        .attach('poster', png(2 * 1024 * 1024 + 1), { filename: 'p.png', contentType: 'image/png' });
      expect(tooBig.status).toBe(413);
    });

    it('200 админу: ключ и размер; GET отдаёт байты, тип и кэш-заголовки', async () => {
      const body = png(1024);
      const up = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .set('Authorization', bearerAdmin)
        .attach('poster', body, { filename: 'poster.png', contentType: 'image/png' });

      expect(up.status).toBe(200);
      expect(up.body).toEqual({ key: `posters/${movieId}`, size: body.length });

      const res = await request(app.getHttpServer()).get(`/api/movies/${movieId}/poster`);
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, body)).toBe(0);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.headers.etag).toBeTruthy();
    });

    it('замена постера: тот же URL, новые байты', async () => {
      const first = png(64);
      await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .set('Authorization', bearerAdmin)
        .attach('poster', first, { filename: 'a.png', contentType: 'image/png' });

      const second = png(32);
      await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .set('Authorization', bearerAdmin)
        .attach('poster', second, { filename: 'b.png', contentType: 'image/png' });

      const res = await request(app.getHttpServer()).get(`/api/movies/${movieId}/poster`);
      expect(Buffer.compare(res.body, second)).toBe(0);
    });

    it('ревалидация: If-None-Match с актуальным ETag — 304 без байтов', async () => {
      const res = await request(app.getHttpServer()).get(`/api/movies/${movieId}/poster`);
      const revalidate = await request(app.getHttpServer())
        .get(`/api/movies/${movieId}/poster`)
        .set('If-None-Match', res.headers.etag);

      expect(revalidate.status).toBe(304);
      expect(revalidate.body).toEqual({});
    });
  });

  describe('DELETE /api/movies/:id/poster (админ)', () => {
    it('401/403 не-админу, 404 несуществующему фильму', async () => {
      expect(
        (
          await request(app.getHttpServer()).delete(`/api/movies/${movieId}/poster`)
        ).status,
      ).toBe(401);
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/api/movies/${movieId}/poster`)
            .set('Authorization', bearer)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/api/movies/${validUuid()}/poster`)
            .set('Authorization', bearerAdmin)
        ).status,
      ).toBe(404);
    });

    it('204 и идемпотентность: повторное удаление — тоже 204, витрина на фолбэке', async () => {
      await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/poster`)
        .set('Authorization', bearerAdmin)
        .attach('poster', png(16), { filename: 'p.png', contentType: 'image/png' });

      expect(
        (
          await request(app.getHttpServer())
            .delete(`/api/movies/${movieId}/poster`)
            .set('Authorization', bearerAdmin)
        ).status,
      ).toBe(204);
      expect(
        (
          await request(app.getHttpServer())
            .delete(`/api/movies/${movieId}/poster`)
            .set('Authorization', bearerAdmin)
        ).status,
      ).toBe(204);

      expect(
        (
          await request(app.getHttpServer()).get(`/api/movies/${movieId}/poster`)
        ).status,
      ).toBe(404);
    });
  });
});
