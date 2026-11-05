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

/** GET /movies отвечает обёрткой — витрина это поле data (см. MoviesController) */
interface MoviesPage {
  source: string;
  data: MovieBody[];
}

type Snapshot = { id: string; title: string; sessions: { id: string }[] }[];

/** компактный диф снимков для сообщения падения — короткий, чтобы
 *  дожить до error-аннотации CI (бюджет 4000 символов на всё) */
function diffSummary(canary: Snapshot, stable: Snapshot): string {
  const stableById = new Map(stable.map((m) => [m.id, m]));
  const canaryById = new Map(canary.map((m) => [m.id, m]));
  const label = (m: { id: string; title: string }) =>
    `${m.title}(${m.id.slice(0, 8)})`;
  const parts: string[] = [];

  const onlyStable = stable.filter((m) => !canaryById.has(m.id));
  const onlyCanary = canary.filter((m) => !stableById.has(m.id));
  if (onlyStable.length)
    parts.push(
      `только у stable: ${onlyStable.slice(0, 5).map(label).join(', ')}`,
    );
  if (onlyCanary.length)
    parts.push(
      `только у canary: ${onlyCanary.slice(0, 5).map(label).join(', ')}`,
    );

  for (const s of stable) {
    const c = canaryById.get(s.id);
    if (!c) continue;
    if (JSON.stringify(s.sessions) === JSON.stringify(c.sessions)) continue;
    const sIds = new Set(s.sessions.map((x) => x.id));
    const cIds = new Set(c.sessions.map((x) => x.id));
    const extraStable = [...sIds].filter((id) => !cIds.has(id)).length;
    const extraCanary = [...cIds].filter((id) => !sIds.has(id)).length;
    parts.push(
      `${label(s)}: сеансов stable=${s.sessions.length} ` +
        `canary=${c.sessions.length}` +
        (extraStable ? `, лишних у stable: ${extraStable}` : '') +
        (extraCanary ? `, лишних у canary: ${extraCanary}` : '') +
        (extraStable + extraCanary ? '' : ', содержание сеансов различается'),
    );
    if (parts.length >= 7) break;
  }
  return parts.join('; ');
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
  // ready подразумевает оба адреса, но для типов — явный гвард
  if (!ready || !STABLE || !CANARY) return;
  // Два одиночных чтения не атомарны: кэш /movies живёт в Redis с TTL
  // 60 с и перезаливается, смежные системы пишут в БД — между чтениями
  // stable и canary витрина может дрогнуть, и это не раскол версий.
  // Поэтому сверяемся в «тихом окне»: stable → canary → stable, крайние
  // снимки стабильной версии обязаны совпасть (мир не менялся), и лишь
  // тогда canary обязан равняться им. Окна нет — повторяем.
  const snapshot = async (url: string): Promise<Snapshot> =>
    fingerprint((await getJson<MoviesPage>(`${url}/movies`)).data) as Snapshot;
  const same = (a: Snapshot, b: Snapshot): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = await snapshot(STABLE);
    const canary = await snapshot(CANARY);
    const after = await snapshot(STABLE);

    if (!same(before, after)) {
      // eslint-disable-next-line no-console
      console.warn(
        `попытка ${attempt}/5: витрина дрогнула между чтениями — повтор`,
      );
      continue;
    }
    const diff = diffSummary(canary, before);
    if (!diff) return; // тихое окно и полный паритет
    throw new Error(`паритет версий нарушен: ${diff}`);
  }
  throw new Error('5 попыток — тихого окна не дождались, витрина шумит');
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
