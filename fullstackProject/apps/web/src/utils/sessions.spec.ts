import { describe, expect, it } from 'vitest';
import { dayKey, hasSessionOnDate, upcomingSessions } from './sessions';

/** ISO-строки из локальных дат — независимость от таймзоны машины */
const iso = (y: number, m: number, d: number, hh = 19, mm = 0) =>
  new Date(y, m, d, hh, mm).toISOString();

describe('dayKey', () => {
  it('локальный YYYY-MM-DD', () => {
    expect(dayKey(new Date(2026, 8, 3, 23, 59))).toBe('2026-09-03');
    expect(dayKey(iso(2026, 8, 3))).toBe('2026-09-03');
  });
});

describe('upcomingSessions', () => {
  const now = new Date(2026, 8, 12, 14, 0);

  it('фильтрует прошедшие и сортирует по времени', () => {
    const sessions = [
      { id: 'late', startsAt: iso(2026, 8, 14, 21) },
      { id: 'past', startsAt: iso(2026, 8, 12, 13) }, // час назад
      { id: 'soon', startsAt: iso(2026, 8, 12, 19) },
    ];

    expect(upcomingSessions(sessions, now).map((s) => s.id)).toEqual([
      'soon',
      'late',
    ]);
  });

  it('граничный случай: сеанс «прямо сейчас» ещё показываем', () => {
    const sessions = [{ id: 'now', startsAt: iso(2026, 8, 12, 14) }];
    expect(upcomingSessions(sessions, now)).toHaveLength(1);
  });

  it('пустой список — пустой результат', () => {
    expect(upcomingSessions([], now)).toEqual([]);
  });
});

describe('hasSessionOnDate', () => {
  const today = new Date(2026, 8, 12, 10, 0);

  it('совпадение по календарному дню', () => {
    const sessions = [
      { id: 's1', startsAt: iso(2026, 8, 12, 23, 30) }, // поздний вечер
    ];
    expect(hasSessionOnDate(sessions, today)).toBe(true);
  });

  it('другой день — false, даже соседний', () => {
    const sessions = [{ id: 's1', startsAt: iso(2026, 8, 13, 0, 30) }];
    expect(hasSessionOnDate(sessions, today)).toBe(false);
  });
});
