/** Контракты сообщений напоминаний о сеансе (обмен «cinema», topic) */

/**
 * reminder-service → notification-service/API: routing key
 * «user.session.reminder» — момент «сеанс − окно» настал. По образцу
 * user.waitlist.seat: адресат едет в поле email, текст письма
 * собирает сервис-отправитель (там живут формулировки).
 */
export interface UserSessionReminderEvent {
  email: string;
  userId: string;
  bookingId: string;
  movieId: string;
  movieTitle: string;
  hall: string;
  /** время сеанса, ISO */
  sessionAt: string;
  /** места брони, коды «ряд-место» */
  seats: string[];
  /** момент отправки, ISO */
  remindedAt: string;
  /** текст письма — готовый, из домена reminder-сервиса */
  message: string;
}

/** Что прилетает SSE-клиенту по событию `reminder` (email не светим — стрим публичен) */
export interface ReminderStreamPayload {
  /** кому — клиент матчит по себе (EventSource без заголовков) */
  userId: string;
  bookingId: string;
  movieId: string;
  movieTitle: string;
  hall: string;
  sessionAt: string;
  seats: string[];
  remindedAt: string;
}
