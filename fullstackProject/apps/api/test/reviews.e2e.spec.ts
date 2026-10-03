/**
 * E2E отзывы и рейтинги — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, token, available, waitForStatus, E2EMovie, freeSeat } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('отзывы и рейтинги', () => {
  const REVIEW_BODY = {
    rating: 5,
    text: 'E2E: смотрел с удовольствием, рекомендую!',
  };

  function postReview(movieId: string, jwt: string) {
    return fetch(`${BASE}/movies/${movieId}/reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(REVIEW_BODY),
    });
  }

  it('отзыв без подтверждённой брони — 403, без токена — 401', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const movieId = movies.data[0].id;

    const anon = await fetch(`${BASE}/movies/${movieId}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(REVIEW_BODY),
    });
    expect(anon.status).toBe(401);

    // свежий пользователь — брони на фильм точно нет
    const email = `e2e-noreview-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'Без Брони' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    const res = await postReview(movieId, login.accessToken);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('бронь');
  }, 30_000);

  it('полный цикл: бронь → CONFIRMED → отзыв → дубль 409 → удаление', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const movie = movies.data[0];

    const catalogCount = async (): Promise<number> => {
      const fresh = await api<{ data: (E2EMovie & { ratingCount: number })[] }>('/movies');
      return fresh.data.find((m) => m.id === movie.id)?.ratingCount ?? 0;
    };
    const before = await catalogCount();

    // право на отзыв даёт CONFIRMED-бронь; воркер отказывает в ~10% — ретраи
    let posted = await postReview(movie.id, token);
    for (let attempt = 0; attempt < 5 && posted.status === 403; attempt++) {
      // место из живой карты: зал 8×10, ряд 9 не существует, а хардкод
      // конфликтовал с соседними файлами
      const seat = await freeSeat(movie.sessions[0].id);
      const created = await api<{ id: string }>('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: movie.sessions[0].id,
          customerName: `E2E отзыв ${attempt}`,
          seats: [seat],
        }),
      });
      await api(`/bookings/${created.id}/pay`, { method: 'POST' });
      const verdict = await waitForStatus(created.id, 'PENDING');
      if (verdict.status !== 'CONFIRMED') continue;
      posted = await postReview(movie.id, token);
    }
    expect(posted.status).toBe(201);
    const review = (await posted.json()) as {
      id: string;
      authorName: string;
      rating: number;
    };
    expect(review.authorName).toBe('E2E Бот');
    expect(review.rating).toBe(5);

    // отзыв в публичном списке, рейтинг фильма подрос в каталоге
    const list = await api<{ id: string }[]>(`/movies/${movie.id}/reviews`);
    expect(list.some((r) => r.id === review.id)).toBe(true);
    expect(await catalogCount()).toBeGreaterThan(before);

    // дубль — 409 reviewExists (арбитр: uq user × movie)
    const again = await postReview(movie.id, token);
    expect(again.status).toBe(409);
    const conflict = (await again.json()) as { code: string };
    expect(conflict.code).toBe('reviewExists');

    // своё удаление: 204, агрегат возвращается
    const del = await fetch(`${BASE}/movies/${movie.id}/reviews/${review.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(204);
    expect(await catalogCount()).toBe(before);
  }, 120_000);
});

