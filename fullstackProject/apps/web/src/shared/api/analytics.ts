/**
 * Трекер поведенческой аналитики: копит события в очереди и батчами
 * (до 50) отправляет на POST /analytics/events — агрегирует Go-сервис
 * «Аналитик» через брокер. До пробы режима события буферизуются,
 * демо-режим (GitHub Pages) не отправляет ничего: трекер — live-only.
 *
 * Правила честности метрик: время пребывания считается только активное
 * (вкладка в фоне часы останавливает), на уходе со страницы очередь
 * уходит sendBeacon'ом, идентичность — anon id из localStorage + userId
 * аккаунта, если вошли. Трекер никогда не роняет UX: любая ошибка
 * отправки глотается.
 */
import { apiUrl } from './client';

/** типы событий — зеркало закрытого набора API/Аналитика */
export type AnalyticsEventType =
  | 'page_view'
  | 'page_dwell'
  | 'booking_modal_open'
  | 'session_selected'
  | 'seats_selected'
  | 'seat_click'
  | 'booking_created'
  | 'payment_opened'
  | 'modal_dwell';

/** разреженные поля события — по смыслу типа */
export interface AnalyticsEventFields {
  route?: string;
  ms?: number;
  deepest?: 'session' | 'seats' | 'created';
  movieId?: string;
  sessionId?: string;
  seat?: string;
  hall?: string;
  count?: number;
  bookingId?: string;
}

interface QueuedEvent extends AnalyticsEventFields {
  type: AnalyticsEventType;
  ts: string;
}

const AID_KEY = 'cine.aid';
/** максимум события в батче — потолок инжест-эндпоинта API */
const BATCH_LIMIT = 50;
/** флаш по таймеру: реже — лишние запросы, чаще — мелкие батчи */
const FLUSH_INTERVAL_MS = 8000;

/** idle — до пробы режима (события буферизуются), дальше live/demo */
let mode: 'idle' | 'live' | 'demo' = 'idle';
let aid = '';
let userId: string | null = null;
let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Инициализация после пробы режима: live — включаем отправку и часы
 * пребывания, демо — очередь сбрасываем (на Pages аналитики нет).
 */
export function initAnalytics(enabled: boolean): void {
  if (mode !== 'idle') return; // повторная инициализация ничего не меняет
  if (!enabled) {
    mode = 'demo';
    queue = [];
    return;
  }
  mode = 'live';
  aid = ensureAid();
  flushTimer = setInterval(() => flush(), FLUSH_INTERVAL_MS);
  document.addEventListener('visibilitychange', onVisibility);
  // уход со страницы: закрываем текущий dwell и досылаем beacon'ом
  window.addEventListener('pagehide', flushBeacon);
  flush();
}

/** идентичность: вход/выход меняет userId; до смены очередь уходит старому */
export function setAnalyticsUser(next: string | null): void {
  if (mode !== 'live') {
    userId = next;
    return;
  }
  if (userId === next) return;
  flush(); // события под прежней личностью уходят прежними
  userId = next;
}

/** поставить событие в очередь; уходит ближайшим флашем */
export function trackAnalytics(
  type: AnalyticsEventType,
  fields: AnalyticsEventFields = {},
): void {
  if (mode === 'demo') return;
  queue.push({ type, ts: new Date().toISOString(), ...fields });
  if (mode === 'live' && queue.length >= BATCH_LIMIT) flush();
  if (queue.length > 500) queue = queue.slice(-500); // страховка от утечки
}

/**
 * Вход на маршрут: закрывает dwell предыдущего, открывает новый.
 * Вызывается из router.afterEach (включая первый заход).
 */
export function enterRoute(route: string): void {
  const previous = routeClock;
  if (previous && previous.route === route) return; // перезагрузка того же
  if (previous) {
    trackAnalytics('page_dwell', {
      route: previous.route,
      ms: previous.stop(),
    });
  }
  trackAnalytics('page_view', { route });
  routeClock = createDwellClock();
  routeClock.route = route;
}

export interface DwellClock {
  route?: string;
  /** активные мс с учётом фона вкладки */
  activeMs(): number;
  /** остановить и вернуть активные мс */
  stop(): number;
}

/**
 * Часы активного пребывания: фон вкладки время останавливает.
 * Маршрут и модалка бронирования заводят каждый свои.
 */
export function createDwellClock(): DwellClock {
  let accumulated = 0;
  let resumeMark = Date.now();
  const hidden = () => document.visibilityState === 'hidden';
  if (hidden()) resumeMark = 0; // создано в фоне — время не идёт
  // свои уши на visibilitychange: остановленные часы слушатель снимают,
  // иначе каждый маршрут и модалка протекали бы слушателем в document
  const onToggle = () => {
    if (hidden()) {
      if (resumeMark) {
        accumulated += Date.now() - resumeMark;
        resumeMark = 0;
      }
    } else if (!resumeMark) {
      // возврат из фона (или часы созданы в фоне): время (пере)запущено
      resumeMark = Date.now();
    }
  };
  document.addEventListener('visibilitychange', onToggle);
  return {
    activeMs() {
      return accumulated + (resumeMark ? Date.now() - resumeMark : 0);
    },
    stop() {
      document.removeEventListener('visibilitychange', onToggle);
      if (resumeMark) {
        accumulated += Date.now() - resumeMark;
        resumeMark = 0;
      }
      return accumulated;
    },
  };
}

let routeClock: (DwellClock & { route?: string }) | null = null;

/** отправить накопленное: keepalive-fetch, ошибки глотаем */
export function flush(): void {
  if (mode !== 'live' || !queue.length) return;
  const events = queue.splice(0, BATCH_LIMIT);
  void fetch(apiUrl('/analytics/events'), {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      aid,
      ...(userId ? { userId } : {}),
      events,
    }),
  }).catch(() => {
    /* сеть/лимиты — аналитика не роняет UX; события не возвращаем:
      дубль при следующем флаше дешевле потери при повторных отказах */
  });
}

/** уход со страницы: dwell текущего маршрута + весь хвост beacon'ом */
function flushBeacon(): void {
  if (mode !== 'live') return;
  if (routeClock) {
    queue.push({
      type: 'page_dwell',
      ts: new Date().toISOString(),
      route: routeClock.route,
      ms: routeClock.stop(),
    });
    routeClock = null;
  }
  if (!queue.length) return;
  const events = queue.splice(0, BATCH_LIMIT);
  navigator.sendBeacon(
    apiUrl('/analytics/events'),
    new Blob(
      [JSON.stringify({ aid, ...(userId ? { userId } : {}), events })],
      { type: 'application/json' },
    ),
  );
}

/** фон: часы останавливаются сами (visibilitychange внутри часов),
 *  но накопленное лучше отправить сейчас — вкладку могут убить */
function onVisibility(): void {
  if (document.visibilityState === 'hidden') flush();
}

/** anon id посетителя: живёт в localStorage, генерируется при первом live-заходе */
function ensureAid(): string {
  try {
    const existing = localStorage.getItem(AID_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(AID_KEY, fresh);
    return fresh;
  } catch {
    // приватный режим/запрет storage — разовый id на вкладку
    return crypto.randomUUID();
  }
}

/** только для тестов: сброс в исходное состояние модуля */
export function resetAnalyticsForTests(): void {
  mode = 'idle';
  aid = '';
  userId = null;
  queue = [];
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  routeClock = null;
}
