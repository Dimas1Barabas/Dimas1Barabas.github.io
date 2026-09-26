/**
 * E2E каталог: афиша и карта зала — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, available, E2EMovie } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

it('movies: из БД, затем из Redis-кэша; у фильмов — сеансы по времени', async () => {
  if (!available) return;
  const first = await api<{ source: string; data: E2EMovie[] }>('/movies');
  const second = await api<{ source: string }>('/movies');

  expect(first.data.length).toBeGreaterThanOrEqual(6);
  expect(['db', 'cache']).toContain(first.source); // могли прогреть раньше
  expect(second.source).toBe('cache');

  // у каждого фильма — отсортированные по startsAt сеансы
  for (const movie of first.data) {
    expect(movie.sessions.length).toBeGreaterThanOrEqual(1);
    const times = movie.sessions.map((s) => Date.parse(s.startsAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  }
});

it('seats: карта зала сеанса с геометрией 8×10', async () => {
  if (!available) return;
  const movies = await api<{ data: E2EMovie[] }>('/movies');
  const session = movies.data[0].sessions[0];
  const map = await api<{
    sessionId: string;
    layout: { rows: number; seatsPerRow: number };
    occupied: string[];
    free: number;
  }>(`/sessions/${session.id}/seats`);

  expect(map.sessionId).toBe(session.id);
  expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
  expect(map.free + map.occupied.length).toBe(80);
  for (const seat of map.occupied) {
    expect(seat).toMatch(/^\d+-\d+$/);
  }
});

