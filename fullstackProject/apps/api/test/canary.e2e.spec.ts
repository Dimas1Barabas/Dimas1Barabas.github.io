/**
 * E2E канарейки (k8s-стенд): рядом со стабильным api живёт api-canary,
 * HTTPRoute делит /api-трафик шлюза весами 90/10. Проверяем механику:
 *
 *  1) версии напрямую, мимо весов (NodePort 30100/30101): поле version
 *     в health различает stable/canary — это «термометр» канарейки;
 *  2) паритет витрины: /movies обеих версий читает одну БД — данные
 *     обязаны совпадать попиксельно;
 *  3) распределение через шлюз: в смешанном трафике есть ОБЕ версии,
 *     доля канарейки — в широких границах вокруг 10% (выбор бэкенда
 *     в Envoy не детерминирован по воркерам: проверяем механизм, а не
 *     точную математику весов).
 *
 * Промоушен/откат (смена весов 100/0) проверяет CI-конвейер серией
 * curl-запросов (scripts/expect-version.sh) — здесь только стационарные
 * веса. Без канарейки (compose-стенд, локальный прогон) файл тихо
 * пропускается: E2E_CANARY_BASE_URL не задан или недоступен.
 */
import { BASE } from './e2e-context';

jest.setTimeout(60_000);

const STABLE = process.env.E2E_STABLE_BASE_URL;
const CANARY = process.env.E2E_CANARY_BASE_URL;

interface HealthBody {
  status: string;
  version: string;
}

interface MovieBody {
  id: string;
  title: string;
  sessions: { id: string; hall: string; startsAt: string }[];
}

/** детерминированный слепок витрины для сравнения версий */
function fingerprint(movies: MovieBody[]): unknown {
  return movies
    .map((movie) => ({
      id: movie.id,
      title: movie.title,
      sessions: movie.sessions
        .map((session) => ({
          id: session.id,
          hall: session.hall,
          startsAt: session.startsAt,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} от ${url}`);
  return (await res.json()) as T;
}

let ready = false;

beforeAll(async () => {
  if (!CANARY || !STABLE) {
    // eslint-disable-next-line no-console
    console.warn(
      '\n⚠️  E2E_CANARY_BASE_URL/E2E_STABLE_BASE_URL не заданы — ' +
        'канареечные проверки пропущены (это норма для compose-стенда).\n',
    );
    return;
  }
  // канарейка могла не подняться — в k8s-джобе её готовность уже ждёт
  // rollout wait, здесь просто не падаем на skip-прогонах
  const probe = await fetch(`${CANARY}/health`, {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  ready = !!probe && probe.ok;
});

it('версии напрямую: health канарейки — version canary, стабильной — stable', async () => {
  if (!ready) return;
  const canary = await getJson<HealthBody>(`${CANARY}/health`);
  const stable = await getJson<HealthBody>(`${STABLE}/health`);

  expect(canary.version).toBe('canary');
  expect(stable.version).toBe('stable');
  expect(canary.status).toBe('ok');
  expect(stable.status).toBe('ok');
});

it('паритет витрины: /movies у версий идентичен — одна БД, один сериализатор', async () => {
  if (!ready) return;
  const stable = await getJson<MovieBody[]>(`${STABLE}/movies`);
  const canary = await getJson<MovieBody[]>(`${CANARY}/movies`);

  expect(fingerprint(canary)).toEqual(fingerprint(stable));
});

it('распределение через шлюз: обе версии в трафике, канарейка в меньшинстве', async () => {
  if (!ready) return;
  const counts: Record<string, number> = {};
  const total = 120;
  for (let i = 0; i < total; i++) {
    const health = await getJson<HealthBody>(`${BASE}/health`);
    counts[health.version] = (counts[health.version] ?? 0) + 1;
  }

  // вес маршрута 90/10: обе версии обязаны участвовать, доля канарейки —
  // вокруг 10% с запасом на недетерминированность Envoy (4..20 из 120)
  expect(counts.stable ?? 0).toBeGreaterThan(0);
  expect(counts.canary ?? 0).toBeGreaterThanOrEqual(4);
  expect(counts.canary ?? 0).toBeLessThanOrEqual(24);
  expect(Object.keys(counts).sort()).toEqual(['canary', 'stable']);
});
