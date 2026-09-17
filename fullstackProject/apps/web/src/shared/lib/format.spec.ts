import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatCountdown,
  formatDayShort,
  formatDuration,
  formatPrice,
  formatRating,
  formatSeats,
  formatSession,
  formatSessionsLine,
  formatTime,
  pluralizeReviews,
  timeAgo,
} from '@/shared/lib/format';

describe('formatCountdown', () => {
  it.each([
    [5 * 60_000, '05:00'],
    [61_000, '01:01'],
    [59_000, '00:59'],
    [0, '00:00'],
    [-5_000, '00:00'], // просрочка клампится в ноль
    [120 * 60_000, '99:59'], // потолок
  ])('%d мс → «%s»', (msLeft, want) => {
    expect(formatCountdown(msLeft)).toBe(want);
  });
});

describe('formatPrice', () => {
  it('добавляет знак рубля', () => {
    expect(formatPrice(450)).toBe('450 ₽');
  });

  it('группирует разряды как в ru-RU', () => {
    expect(formatPrice(2000)).toBe(`${(2000).toLocaleString('ru-RU')} ₽`);
    expect(formatPrice(1350)).toBe(`${(1350).toLocaleString('ru-RU')} ₽`);
  });
});

describe('formatSeats', () => {
  it('коды мест через запятую', () => {
    expect(formatSeats(['5-7', '5-8'])).toBe('5-7, 5-8');
  });

  it('одно место — без запятых', () => {
    expect(formatSeats(['1-10'])).toBe('1-10');
  });
});

describe('formatDuration', () => {
  it('часы и минуты', () => {
    expect(formatDuration(132)).toBe('2 ч 12 мин');
    expect(formatDuration(98)).toBe('1 ч 38 мин');
  });

  it('меньше часа — только минуты', () => {
    expect(formatDuration(45)).toBe('45 мин');
  });
});

describe('formatSession', () => {
  it('день, месяц и время сеанса', () => {
    // локальная дата, чтобы не зависеть от таймзоны машины
    const iso = new Date(2026, 8, 3, 19, 0).toISOString();
    const out = formatSession(iso);
    expect(out).toContain('сентября');
    expect(out).toContain('19:00');
    expect(out).toContain('3');
  });
});

describe('formatTime', () => {
  it('только часы и минуты', () => {
    const iso = new Date(2026, 8, 3, 9, 5).toISOString();
    expect(formatTime(iso)).toBe('09:05');
  });
});

describe('formatDayShort', () => {
  it('сегодня / завтра по календарным дням, не по часам', () => {
    const now = new Date(2026, 8, 12, 23, 30);
    // вчера 23:59 — всё ещё «вчера», не «сегодня»
    expect(formatDayShort(new Date(2026, 8, 11, 23, 59).toISOString(), now)).not.toBe(
      'сегодня',
    );
    expect(formatDayShort(new Date(2026, 8, 12, 0, 1).toISOString(), now)).toBe('сегодня');
    expect(formatDayShort(new Date(2026, 8, 13, 10, 0).toISOString(), now)).toBe('завтра');
  });

  it('далёкие дни — число и короткий месяц', () => {
    const now = new Date(2026, 8, 12);
    const out = formatDayShort(new Date(2026, 8, 20, 19, 0).toISOString(), now);
    expect(out).toContain('20');
  });
});

describe('formatSessionsLine', () => {
  const now = new Date(2026, 8, 12, 12, 0);

  it('пусто и все прошедшие — «Сеансов нет»', () => {
    expect(formatSessionsLine([], now)).toBe('Сеансов нет');
    const past = [{ id: 's', startsAt: new Date(2026, 8, 11, 19, 0).toISOString() }];
    expect(formatSessionsLine(past, now)).toBe('Сеансов нет');
  });

  it('один-два сеанса — без хвоста', () => {
    const one = [{ id: 's1', startsAt: new Date(2026, 8, 12, 19, 0).toISOString() }];
    expect(formatSessionsLine(one, now)).toBe('сегодня 19:00');

    const two = [
      ...one,
      { id: 's2', startsAt: new Date(2026, 8, 13, 21, 0).toISOString() },
    ];
    expect(formatSessionsLine(two, now)).toBe('сегодня 19:00 · завтра 21:00');
  });

  it('три и больше — первые два и счётчик остатка', () => {
    const many = [
      { id: 's1', startsAt: new Date(2026, 8, 12, 19, 0).toISOString() },
      { id: 's2', startsAt: new Date(2026, 8, 13, 21, 0).toISOString() },
      { id: 's3', startsAt: new Date(2026, 8, 14, 15, 0).toISOString() },
      { id: 's4', startsAt: new Date(2026, 8, 15, 12, 0).toISOString() },
    ];
    expect(formatSessionsLine(many, now)).toBe(
      'сегодня 19:00 · завтра 21:00 · ещё 2',
    );
  });
});

describe('timeAgo', () => {
  afterEach(() => vi.useRealTimers());

  it('нет метки — прочерк', () => {
    expect(timeAgo(null)).toBe('—');
  });

  it('давность в секундах и минутах', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'));

    expect(timeAgo(Date.now())).toBe('только что');
    expect(timeAgo(Date.now() - 10_000)).toBe('10 с назад');
    expect(timeAgo(Date.now() - 120_000)).toBe('2 мин назад');
  });
});

describe('formatRating', () => {
  it('запятая как разделитель, один знак после неё', () => {
    expect(formatRating(4.5)).toBe('4,5');
    expect(formatRating(4)).toBe('4,0');
    expect(formatRating(4.6667)).toBe('4,7');
  });

  it('ноль — прочерк (отзывов нет)', () => {
    expect(formatRating(0)).toBe('—');
  });
});

describe('pluralizeReviews', () => {
  it.each([
    [1, '1 отзыв'],
    [2, '2 отзыва'],
    [4, '4 отзыва'],
    [5, '5 отзывов'],
    [11, '11 отзывов'],
    [21, '21 отзыв'],
    [22, '22 отзыва'],
  ])('%d → «%s»', (n, want) => {
    expect(pluralizeReviews(n)).toBe(want);
  });
});
