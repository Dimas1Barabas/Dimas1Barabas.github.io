/**
 * e2e внешних метаданных афиши (этап 37) против живого стенда: compose-API
 * + мок-контейнер kinoapi (host-порт 18100). Полный путь на настоящих
 * костях: fetch → resilience-клиент → PG → SeaweedFS; chaos-ручки мока
 * (/__chaos, /__stats) доказывают breaker поведением — «вверх не ходили»
 * видно по замершему счётчику поисков.
 */
import { api, adminToken, available, BASE, bootstrap, token } from './e2e-context';

jest.setTimeout(60_000);

/** мок-справочник на хосте (compose публикует 18100) */
const KINOAPI = process.env.KINOAPI_URL ?? 'http://localhost:18100';

interface MovieDto {
  id: string;
  title: string;
  external?: { rating: number; trailerUrl: string };
}

async function kinoapiChaos(mode: string): Promise<void> {
  const res = await fetch(`${KINOAPI}/__chaos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`kinoapi chaos ${mode}: HTTP ${res.status}`);
}

async function kinoapiSearchHits(): Promise<number> {
  const res = await fetch(`${KINOAPI}/__stats`);
  const stats = (await res.json()) as { search: number };
  return stats.search;
}

/** POST синка от имени админа — статус и тело */
async function syncAsAdmin(
  movieId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/movies/${movieId}/external-sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await adminToken()}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('внешние метаданные афиши (e2e-стенд + kinoapi-мок)', () => {
  let milkyId: string;

  beforeAll(async () => {
    await bootstrap();
    if (!available) return;
    // каталог приходит обёрткой { source, data }
    const cat = await api<{ data: MovieDto[] }>('/movies');
    milkyId = cat.data.find((m) => m.title.includes('Млечный'))!.id;
  });

  it('стенд знает справочник: статус включён, breaker закрыт', async () => {
    if (!available) return;
    const status = await api<{
      enabled: boolean;
      breaker: { state: string };
    }>('/admin/external-movies/status');
    expect(status.enabled).toBe(true);
    expect(status.breaker.state).toBe('closed');
  });

  it('синк: external в каталоге, постер мока доехал до SeaweedFS', async () => {
    if (!available) return;
    const res = await syncAsAdmin(milkyId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matched: true });
    expect((res.body.external as { rating: number }).rating).toBeCloseTo(8.3);

    const cat = await api<{ data: MovieDto[] }>('/movies');
    const milky = cat.data.find((m) => m.id === milkyId);
    expect(milky?.external).toMatchObject({
      rating: 8.3,
      trailerUrl: 'https://trailers.example/milky-way-nebula',
    });

    // постер: PNG мока лежит в бакете и раздаётся с кэш-заголовками
    const poster = await fetch(`${BASE}/movies/${milkyId}/poster`);
    expect(poster.status).toBe(200);
    expect(poster.headers.get('content-type')).toContain('image/png');
    const bytes = Buffer.from(await poster.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(100); // настоящий PNG, не огрызок
    expect(bytes[0]).toBe(0x89);
  });

  it('справочник не знает фильм — matched:false, external в каталоге не появляется', async () => {
    if (!available) return;
    const created = await api<MovieDto>('/movies', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await adminToken()}` },
      body: JSON.stringify({
        title: `Неизвестное кино ${Date.now()}`,
        description: 'e2e: справочник такого не знает',
        genre: 'драма',
        genreIcon: '🎭',
        durationMin: 80,
        priceRub: 300,
        hue: 20,
        sessions: [
          { hall: 'Красный', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
        ],
      }),
    });
    const res = await syncAsAdmin(created.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matched: false, reason: 'not_found' });

    const cat = await api<{ data: MovieDto[] }>('/movies');
    const unknown = cat.data.find((m) => m.id === created.id);
    expect(unknown?.external).toBeUndefined();
  });

  it('breaker: открытие по пятисотым, «вверх не ходили», полупроба лечит', async () => {
    if (!available) return;
    await kinoapiChaos('500');

    // стенд-настройки: порог 3, кулдаун 5 c (compose), ретраи 2 — три
    // неудачных синка открывают цепь
    for (let i = 0; i < 3; i++) {
      const res = await syncAsAdmin(milkyId);
      expect(res.status).toBe(502);
    }

    const openStatus = await api<{
      breaker: { state: string; failures: number };
    }>('/admin/external-movies/status');
    expect(openStatus.breaker.state).toBe('open');

    // открытая цепь: 502 мгновенно и БЕЗ походов к справочнику
    const hitsBefore = await kinoapiSearchHits();
    const fast = await syncAsAdmin(milkyId);
    expect(fast.status).toBe(502);
    expect(String(fast.body.message)).toMatch(/breaker/);
    expect(await kinoapiSearchHits()).toBe(hitsBefore); // вверх не ходили!

    // каталог жив при открытом breaker — деградация, не сбой
    const cat = await api<{ data: MovieDto[] }>('/movies');
    expect(cat.data.find((m) => m.id === milkyId)?.external).toBeTruthy();

    // восстановление: кулдаун 5 c -> полупроба успешна, цепь закрыта
    await kinoapiChaos('ok');
    await new Promise((r) => setTimeout(r, 5200));
    const healed = await syncAsAdmin(milkyId);
    expect(healed.status).toBe(200);
    expect(healed.body).toMatchObject({ matched: true });

    const closedStatus = await api<{
      breaker: { state: string };
    }>('/admin/external-movies/status');
    expect(closedStatus.breaker.state).toBe('closed');
  });

  it('синк недоступен обычному пользователю и анониму', async () => {
    if (!available) return;
    const anon = await fetch(`${BASE}/movies/${milkyId}/external-sync`, {
      method: 'POST',
    });
    expect(anon.status).toBe(401);

    const user = await fetch(`${BASE}/movies/${milkyId}/external-sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(user.status).toBe(403);
  });
});
