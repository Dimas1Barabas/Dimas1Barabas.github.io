/**
 * Логика расписания сеансов — чистые функции без зависимостей от сторов:
 * один источник правды для модалки брони и фильтров афиши.
 */

export interface SessionLike {
  id: string;
  startsAt: string;
}

/** Локальный ключ дня 'YYYY-MM-DD' — общая база сравнения дат */
export function dayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Будущие сеансы по возрастанию времени (прошедшие не показываем) */
export function upcomingSessions<T extends SessionLike>(
  sessions: T[],
  now: Date = new Date(),
): T[] {
  const threshold = now.getTime();
  return sessions
    .filter((s) => new Date(s.startsAt).getTime() >= threshold)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/** Есть ли сеанс в календарный день `date` (локальное время) */
export function hasSessionOnDate(
  sessions: SessionLike[],
  date: Date,
): boolean {
  const key = dayKey(date);
  return sessions.some((s) => dayKey(s.startsAt) === key);
}
