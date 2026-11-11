/**
 * Постеры фильмов (этап 29), e2e-уровень: сквозной путь живого стенда —
 * HTTP → multer → PostersService → SeaweedFS (SigV4-шлюз). Compose-стенд
 * поднимает хранилище зависимостью api, k8s — StatefulSet'ом; сьют один
 * на оба (E2E_BASE_URL), поэтому пробуем только публичный контракт без
 * деталей стенда. Фильм создаём свой — постеры не задевают общий каталог.
 * Без стенда файл тихо скипается (см. e2e-context).
 */
import { adminToken, api, BASE, bootstrap, available, token } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

/** png-подобный буфер: сигнатура + заполнители */
const png = (size = 64): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.alloc(Math.max(0, size - 4), 7),
  ]);

const posterUrl = (id: string): string => `${BASE}/movies/${id}/poster`;

async function uploadPoster(
  id: string,
  body: Buffer,
  contentType = 'image/png',
  filename = 'poster.png',
  auth?: string,
): Promise<Response> {
  const form = new FormData();
  form.append(
    'poster',
    new Blob([new Uint8Array(body)], { type: contentType }),
    filename,
  );
  return fetch(posterUrl(id), {
    method: 'POST',
    headers: auth ? { Authorization: auth } : undefined,
    body: form,
  });
}

describe('постеры фильмов: S3 сквозь весь стенд', () => {
  let movieId: string;
  let admin: string;

  beforeAll(async () => {
    if (!available) return;
    admin = await adminToken();
    // свой фильм на файл: постер-операции не трогают общий каталог
    const created = await api<{ id: string }>('/movies', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}` },
      body: JSON.stringify({
        title: 'E2E Постеры',
        description: 'Фильм для сквозной проверки S3-постеров',
        genre: 'e2e',
        genreIcon: '🖼️',
        durationMin: 75,
        priceRub: 350,
        hue: 210,
        sessions: [{ hall: 'e2e-hall', startsAt: '2030-01-01T12:00:00.000Z' }],
      }),
    });
    movieId = created.id;
  });

  it('без постера GET — 404: витрина на градиентном фолбэке', async () => {
    if (!available) return;

    const res = await fetch(posterUrl(movieId));
    expect(res.status).toBe(404);
  });

  it('админская загрузка — 200; GET отдаёт те же байты с кэш-заголовками', async () => {
    if (!available) return;

    const body = png(4096);
    const up = await uploadPoster(movieId, body, 'image/png', 'poster.png', `Bearer ${admin}`);
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ key: `posters/${movieId}`, size: body.length });

    const res = await fetch(posterUrl(movieId));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), body)).toBe(0);
  });

  it('If-None-Match с живым ETag — 304 без байтов', async () => {
    if (!available) return;

    const res = await fetch(posterUrl(movieId));
    const revalidate = await fetch(posterUrl(movieId), {
      headers: { 'If-None-Match': res.headers.get('etag')! },
    });
    expect(revalidate.status).toBe(304);
    expect((await revalidate.arrayBuffer()).byteLength).toBe(0);
  });

  it('замена постера: ключ тот же, байты новые', async () => {
    if (!available) return;

    const second = png(128);
    const up = await uploadPoster(movieId, second, 'image/png', 'b.png', `Bearer ${admin}`);
    expect(up.status).toBe(200);

    const res = await fetch(posterUrl(movieId));
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), second)).toBe(0);
  });

  it('не-изображение — 415 до похода в хранилище', async () => {
    if (!available) return;

    const res = await uploadPoster(
      movieId,
      Buffer.from('точно не картинка'),
      'text/plain',
      'note.txt',
      `Bearer ${admin}`,
    );
    expect(res.status).toBe(415);
  });

  it('обычному пользователю и анониму загрузка запрещена — 403/401', async () => {
    if (!available) return;

    const asUser = await uploadPoster(movieId, png(), 'image/png', 'u.png', `Bearer ${token}`);
    expect(asUser.status).toBe(403);

    const anon = await uploadPoster(movieId, png());
    expect(anon.status).toBe(401);
  });

  it('удаление — 204, идемпотентно; после — 404', async () => {
    if (!available) return;

    const first = await fetch(posterUrl(movieId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(first.status).toBe(204);

    const again = await fetch(posterUrl(movieId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(again.status).toBe(204);

    const res = await fetch(posterUrl(movieId));
    expect(res.status).toBe(404);
  });
});
