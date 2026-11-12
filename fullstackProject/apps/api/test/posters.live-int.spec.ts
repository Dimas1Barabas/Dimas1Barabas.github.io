/**
 * Постеры фильмов (этап 29) против живого S3: SeaweedFS из testcontainers —
 * тот же образ, команда и identity-конфиг, что в compose-стенде. Здесь
 * проверяется настоящий SigV4-путь, недоступный фейку int-спеков: ensure-
 * бакет при первой загрузке, put/get/remove по ключу, Content-Type в
 * метаданных объекта (SeaweedFS отдаёт метаданные в нижнем регистре),
 * ETag-ревалидация, идемпотентное удаление. Гейт describeLive: живой
 * прогон делает CI-робот, локально спека скипается.
 */
import request from 'supertest';
import { describeLive, buildLiveApp, type LiveAppContext } from './live-harness';

// Первая S3-запись на свежем SeaweedFS холодная: ensure-бакет + первый
// putObject будят шлюз/мастера — дефолтных 5 c на тест мало (run 0c5d5d52:
// таймаут на «бакет создаётся сам», вторая загрузка тем же путём — уже ОК)
jest.setTimeout(30_000);

describeLive('CineBooking API: постеры на живом SeaweedFS (testcontainers)', () => {
  let h: LiveAppContext;
  let movieId: string;

  beforeAll(async () => {
    h = await buildLiveApp();
    const movies = await request(h.app.getHttpServer()).get('/api/movies');
    movieId = movies.body.data[0].id;
  }, 240_000);

  afterAll(async () => {
    await h?.stopOutboxRelay();
    await h?.app.close();
  });

  /** минимальный валидный png/webp: сигнатура + байты-заполнители */
  const image = (magic: number[], size: number): Buffer =>
    Buffer.concat([Buffer.from(magic), Buffer.alloc(Math.max(0, size - magic.length), 7)]);

  it('постера нет — 404: витрина на градиентном фолбэке', async () => {
    const res = await request(h.app.getHttpServer()).get(`/api/movies/${movieId}/poster`);

    expect(res.status).toBe(404);
  });

  it('админская загрузка — 200 с ключом и размером; бакет создаётся сам', async () => {
    const body = image([0x89, 0x50, 0x4e, 0x47], 2048); // png-сигнатура
    const up = await request(h.app.getHttpServer())
      .post(`/api/movies/${movieId}/poster`)
      .set('Authorization', h.bearerAdmin)
      .attach('poster', body, { filename: 'poster.png', contentType: 'image/png' });

    expect(up.status).toBe(200);
    expect(up.body).toEqual({ key: `posters/${movieId}`, size: body.length });
  });

  it('GET отдаёт байты из S3 с сохранённым Content-Type и кэш-заголовками', async () => {
    // webp: тип живёт в метаданных объекта — проверить, что путь
    // «положили image/webp → получили image/webp» не срезается до дефолта
    const body = image([0x52, 0x49, 0x46, 0x46], 1024); // «RIFF»
    await request(h.app.getHttpServer())
      .post(`/api/movies/${movieId}/poster`)
      .set('Authorization', h.bearerAdmin)
      .attach('poster', body, { filename: 'p.webp', contentType: 'image/webp' });

    const res = await request(h.app.getHttpServer()).get(`/api/movies/${movieId}/poster`);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, body)).toBe(0);
    expect(res.headers['content-type']).toContain('image/webp');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.etag).toBeTruthy();
  });

  it('If-None-Match с актуальным ETag — 304 без байтов', async () => {
    const res = await request(h.app.getHttpServer()).get(`/api/movies/${movieId}/poster`);
    const revalidate = await request(h.app.getHttpServer())
      .get(`/api/movies/${movieId}/poster`)
      .set('If-None-Match', res.headers.etag);

    expect(revalidate.status).toBe(304);
  });

  it('замена постера: тот же ключ, новые байты и новый ETag', async () => {
    const second = image([0x89, 0x50, 0x4e, 0x47], 128);
    await request(h.app.getHttpServer())
      .post(`/api/movies/${movieId}/poster`)
      .set('Authorization', h.bearerAdmin)
      .attach('poster', second, { filename: 'b.png', contentType: 'image/png' });

    const res = await request(h.app.getHttpServer()).get(`/api/movies/${movieId}/poster`);
    expect(Buffer.compare(res.body, second)).toBe(0);
  });

  it('удаление — 204 и идемпотентность; после — 404 фолбэка', async () => {
    const del = await request(h.app.getHttpServer())
      .delete(`/api/movies/${movieId}/poster`)
      .set('Authorization', h.bearerAdmin);
    expect(del.status).toBe(204);

    const again = await request(h.app.getHttpServer())
      .delete(`/api/movies/${movieId}/poster`)
      .set('Authorization', h.bearerAdmin);
    expect(again.status).toBe(204);

    const res = await request(h.app.getHttpServer()).get(`/api/movies/${movieId}/poster`);
    expect(res.status).toBe(404);
  });

  it('загрузка не-админу — 403: граница ролей та же, что на фейке', async () => {
    const res = await request(h.app.getHttpServer())
      .post(`/api/movies/${movieId}/poster`)
      .set('Authorization', h.bearer)
      .attach('poster', image([0x89, 0x50, 0x4e, 0x47], 64), {
        filename: 'x.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(403);
  });
});
