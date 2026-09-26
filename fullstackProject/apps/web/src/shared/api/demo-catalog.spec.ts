/**
 * Демо-движок: каталог: афиша, карта и квот — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { HALL_CAPACITY } from '@/shared/lib/hall';
import { firstFreeSeats, firstSession } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: каталог: афиша, карта и квот', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('первая выдача фильмов «из БД», повторная — «из кэша»', () => {
    const first = demoEngine.movies();
    const second = demoEngine.movies();

    expect(first.source).toBe('db');
    expect(second.source).toBe('cache');
    expect(first.data.length).toBeGreaterThan(0);
    expect(first.data[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      priceRub: expect.any(Number),
      sessions: expect.any(Array),
    });
    // у каждого фильма — расписание, отсортированное по времени
    for (const movie of first.data) {
      expect(movie.sessions.length).toBeGreaterThanOrEqual(2);
      const times = movie.sessions.map((s) => Date.parse(s.startsAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('seatMap: геометрия зала, часть мест посеяна, счётчик сходится', () => {
    const { session } = firstSession();
    const map = demoEngine.seatMap(session.id);

    expect(map.sessionId).toBe(session.id);
    expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(map.occupied.length).toBeGreaterThan(0); // зал не пустой
    expect(map.occupied.length).toBeLessThan(HALL_CAPACITY);
    expect(map.free).toBe(HALL_CAPACITY - map.occupied.length);
    // посев детерминирован: та же карта при повторном запросе
    expect(demoEngine.seatMap(session.id).occupied).toEqual(map.occupied);
  });

  it('seatMap: неизвестный сеанс — ошибка', () => {
    expect(() => demoEngine.seatMap('нет-такого')).toThrow();
  });

  it('quote: раскладка Тарификатора — база афиши, цена кратна 10, dynamic', () => {
    const { movie, session } = firstSession();
    const q = demoEngine.quote(session.id);

    expect(q.sessionId).toBe(session.id);
    expect(q.sessionAt).toBe(session.startsAt);
    expect(q.basePriceRub).toBe(movie.priceRub);
    expect(q.priceRub % 10).toBe(0);
    expect(q.dynamic).toBe(true); // в демо Тарификатор «всегда доступен»
    const codes = q.factors.map((f) => f.code);
    for (const code of codes) {
      expect([
        'morning',
        'evening',
        'weekend',
        'demand_low',
        'demand_high',
        'demand_full',
      ]).toContain(code);
    }
  });

  it('quote: неизвестный сеанс — ошибка', () => {
    expect(() => demoEngine.quote('нет-такого')).toThrow();
  });

  it('спрос подрос — квот дорожает: фактор заполненности следует карте', () => {
    const { session } = firstSession();
    const before = demoEngine.quote(session.id);
    // догоняем занятость до «высокого спроса»: за половину ёмкости
    const map = demoEngine.seatMap(session.id);
    const need = Math.max(Math.ceil(80 * 0.5) - map.occupied.length + 1, 1);
    const seats = firstFreeSeats(map, need);
    demoEngine.create({ sessionId: session.id, customerName: 'Толпа', seats });

    const after = demoEngine.quote(session.id);
    expect(after.factors.map((f) => f.code)).toContain('demand_high');
    expect(after.priceRub).toBeGreaterThan(before.priceRub);
  });

});
