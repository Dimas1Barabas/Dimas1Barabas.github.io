import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatDuration,
  formatPrice,
  formatSeats,
  formatSession,
  timeAgo,
} from './format';

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
