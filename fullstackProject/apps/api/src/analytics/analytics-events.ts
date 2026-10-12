/** Контракты событий поведенческой аналитики (обмен «cinema», rk «analytics.event») */

/** routing key потока событий поведения с веба */
export const ANALYTICS_EVENT_RK = 'analytics.event';

/**
 * Типы событий — путь зрителя шаг за шагом: страницы, модалка бронирования,
 * карта мест, оплата. Транзакционную сторону (бронь оплачена/подтверждена)
 * достраивает сервис-Аналитик из готовых booking.*-событий брокера.
 */
export const ANALYTICS_EVENT_TYPES = [
  /** вход на маршрут */
  'page_view',
  /** активное время на маршруте (вкладка в фоне не считается) */
  'page_dwell',
  /** открыта модалка фильма */
  'booking_modal_open',
  /** выбран сеанс в модалке */
  'session_selected',
  /** отправлена бронь — места выбраны */
  'seats_selected',
  /** клик по месту на карте (включая снятие) */
  'seat_click',
  /** бронь создана — резерв мест до окна оплаты */
  'booking_created',
  /** открыт шаг оплаты */
  'payment_opened',
  /** активное время в модалке + глубина пройденного пути */
  'modal_dwell',
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/**
 * Общий конверт события: тип + разреженные поля по смыслу. aid/userId
 * проставляет API из конверта батча — клиент дублирует их в каждое
 * событие только при смене (например, зритель вошёл между кликами).
 */
export interface AnalyticsEventMessage {
  /** anon id посетителя (localStorage на вебе) */
  aid: string;
  /** если событие случилось под аккаунтом — id пользователя */
  userId?: string;
  type: AnalyticsEventType;
  /** ISO-время события на клиенте */
  ts: string;
  /** page_*: маршрут роутера */
  route?: string;
  /** page_dwell/modal_dwell: активные миллисекунды */
  ms?: number;
  /** modal_dwell: как глубоко дошёл — session | seats | created */
  deepest?: 'session' | 'seats' | 'created';
  movieId?: string;
  sessionId?: string;
  /** seat_click: код места «ряд-место», например 5-7 */
  seat?: string;
  /** seat_click: зал — тепловая карта копится по залам */
  hall?: string;
  /** seats_selected: сколько мест выбрано */
  count?: number;
  bookingId?: string;
}
