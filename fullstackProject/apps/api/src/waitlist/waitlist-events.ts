/** Контракты сообщений RabbitMQ листа ожидания (обмен «cinema», topic) */

/** почему места вернулись в продажу — причина освобождения */
export type WaitlistReleaseReason =
  | 'EXPIRED' // таймаут окна оплаты
  | 'FAILED' // платёж не прошёл (вердикт воркера)
  | 'CANCELLED_UNPAID' // отменил до оплаты
  | 'REFUNDED'; // возврат по подтверждённой брони

/**
 * API → API: routing key «waitlist.seat.released».
 * Публикуется в четырёх точках, где места возвращаются в продажу;
 * консьюмер api.waitlist.released уведомляет голову очереди. Контекст
 * фильма не нужен в событии — консьюмер сам перечитает сеанс из БД.
 */
export interface WaitlistSeatReleasedEvent {
  sessionId: string;
  bookingId: string;
  /** освободившиеся места, коды «ряд-место» */
  seats: string[];
  reason: WaitlistReleaseReason;
  /** момент освобождения, ISO */
  releasedAt: string;
}

/**
 * API → notification-service: routing key «user.waitlist.seat» —
 * «место освободилось» первому в листе ожидания. По образцу
 * user.password.reset: адресат едет в поле email.
 */
export interface UserWaitlistSeatEvent {
  email: string;
  userId: string;
  sessionId: string;
  movieId: string;
  movieTitle: string;
  hall: string;
  /** время сеанса, ISO */
  sessionAt: string;
  /** текст письма: куда бежать за местом */
  message: string;
}

/** Что прилетает SSE-клиенту по событию `waitlist` */
export interface WaitlistStreamPayload {
  /** кому — клиент матчит по своим записям (EventSource без заголовков) */
  userId: string;
  sessionId: string;
  movieId: string;
  movieTitle: string;
  hall: string;
  sessionAt: string;
  /** освободившиеся места */
  seats: string[];
  notifiedAt: string;
}
