export function formatSession(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Только время сеанса: «19:00» */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Короткая метка дня: «сегодня» / «завтра» / «12 сен» */
export function formatDayShort(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const oneDayMs = 86_400_000;
  // сравниваем календарные дни, а не разницу часов: вчера 23:59 ≠ «сегодня»
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(date) - startOf(now)) / oneDayMs);
  if (diffDays === 0) return 'сегодня';
  if (diffDays === 1) return 'завтра';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

/** Строка ближайших сеансов для карточки: «сегодня 19:00 · завтра 21:00 · ещё 2» */
export function formatSessionsLine(
  sessions: { id: string; startsAt: string }[],
  now: Date = new Date(),
): string {
  const upcoming = sessions
    .filter((s) => new Date(s.startsAt).getTime() >= now.getTime())
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  if (!upcoming.length) return 'Сеансов нет';
  const head = upcoming
    .slice(0, 2)
    .map((s) => `${formatDayShort(s.startsAt, now)} ${formatTime(s.startsAt)}`)
    .join(' · ');
  const rest = upcoming.length - 2;
  return rest > 0 ? `${head} · ещё ${rest}` : head;
}

export function formatPrice(rub: number): string {
  return `${rub.toLocaleString('ru-RU')} ₽`;
}

/** Коды мест в человеческий вид: ["5-7","5-8"] → «5-7, 5-8» */
export function formatSeats(seats: string[]): string {
  return seats.join(', ');
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
}

export function timeAgo(ts: number | null): string {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return 'только что';
  if (sec < 60) return `${sec} с назад`;
  return `${Math.floor(sec / 60)} мин назад`;
}
