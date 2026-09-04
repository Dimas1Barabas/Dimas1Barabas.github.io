import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from './demoEngine';
import { ApiError } from './client';
import { HALL_CAPACITY } from '../utils/hall';
import type { SeatMap } from './types';

/** Движок демо-режима должен повторять контракт реального API + поведение Go-воркера */

/** первое свободное место карты — чтобы тесты не зависели от посева */
function freeSeat(map: SeatMap): string {
  const free = map.layout.rows;
  for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) return code;
    }
  }
  throw new Error('зал заполнен');
}

function firstFreeSeats(map: SeatMap, count: number): string[] {
  const seats: string[] = [];
  outer: for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) {
        seats.push(code);
        if (seats.length === count) break outer;
      }
    }
  }
  return seats;
}

describe('demoEngine', () => {
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
      sessionAt: expect.any(String),
    });
  });

  it('seatMap: геометрия зала, часть мест посеяна, счётчик сходится', () => {
    const movie = demoEngine.movies().data[0];
    const map = demoEngine.seatMap(movie.id);

    expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(map.occupied.length).toBeGreaterThan(0); // зал не пустой
    expect(map.occupied.length).toBeLessThan(HALL_CAPACITY);
    expect(map.free).toBe(HALL_CAPACITY - map.occupied.length);
    // посев детерминирован: та же карта при повторном запросе
    expect(demoEngine.seatMap(movie.id).occupied).toEqual(map.occupied);
  });

  it('seatMap: неизвестный фильм — ошибка', () => {
    expect(() => demoEngine.seatMap('нет-такого')).toThrow();
  });

  it('create: PENDING с местами и суммой, затем вердикт «воркера»', async () => {
    const movie = demoEngine.movies().data[0];
    const seats = firstFreeSeats(demoEngine.seatMap(movie.id), 3);
    // 0.1 < SUCCESS_RATE → «воркер» подтверждает оплату (и тайминг 1,36 с)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const booking = demoEngine.create({
      movieId: movie.id,
      customerName: 'Тест',
      seats,
    });

    expect(booking.status).toBe('PENDING');
    expect(booking.seats).toEqual(seats);
    expect(booking.totalRub).toBe(movie.priceRub * 3);
    expect(booking.message).toBeNull();

    const inList = demoEngine.list()[0];
    expect(inList.id).toBe(booking.id);

    // «воркер» срабатывает в окне 1,2–2,8 c
    await vi.advanceTimersByTimeAsync(3000);
    randomSpy.mockRestore();
    const done = demoEngine.list()[0];
    expect(done.status).toBe('CONFIRMED');
    expect(done.message).toContain(seats.join(', ')); // в чеке — реальные места
    expect(done.processedBy).toBe('go-worker (демо)');
    expect(done.processedAt).toBeTruthy();
  });

  it('create: занятое место — ApiError 409 со списком мест', () => {
    const movie = demoEngine.movies().data[0];
    const map = demoEngine.seatMap(movie.id);
    const taken = map.occupied[0];
    const fresh = freeSeat(map);

    const conflict = () =>
      demoEngine.create({
        movieId: movie.id,
        customerName: 'Конфликт',
        seats: [fresh, taken],
      });

    expect(conflict).toThrow(ApiError);
    try {
      conflict();
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(409);
      expect(JSON.parse(apiErr.body).seatsTaken).toEqual([taken]);
    }
    // свободное место из отклонённой брони не занялось
    expect(demoEngine.seatMap(movie.id).occupied).not.toContain(fresh);
  });

  it('create: дубли мест в запросе схлопываются, неверный код — 400', () => {
    const movie = demoEngine.movies().data[0];
    const seat = freeSeat(demoEngine.seatMap(movie.id));

    const booking = demoEngine.create({
      movieId: movie.id,
      customerName: 'Дубли',
      seats: [seat, seat],
    });
    expect(booking.seats).toEqual([seat]);

    expect(() =>
      demoEngine.create({ movieId: movie.id, customerName: 'Бред', seats: ['99-1'] }),
    ).toThrow(ApiError);
  });

  it('FAILED освобождает место — его снова можно забронировать', async () => {
    const movie = demoEngine.movies().data[0];
    const seat = freeSeat(demoEngine.seatMap(movie.id));

    // вердикт «воркера» зависит от Math.random: 0.95 > SUCCESS_RATE → отказ
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.95);
    demoEngine.create({ movieId: movie.id, customerName: 'Отказ', seats: [seat] });
    await vi.advanceTimersByTimeAsync(3000);
    randomSpy.mockRestore();

    expect(demoEngine.list()[0].status).toBe('FAILED');
    expect(demoEngine.seatMap(movie.id).occupied).not.toContain(seat);

    // место снова в продаже — повторная бронь проходит без конфликта
    expect(() =>
      demoEngine.create({ movieId: movie.id, customerName: 'Повтор', seats: [seat] }),
    ).not.toThrow();
  });

  it('статистика сходится со списком', async () => {
    const movie = demoEngine.movies().data[0];
    const seats = firstFreeSeats(demoEngine.seatMap(movie.id), 2);
    demoEngine.create({ movieId: movie.id, customerName: 'Стат', seats: [seats[0]] });
    demoEngine.create({ movieId: movie.id, customerName: 'Стат', seats: [seats[1]] });

    let stats = demoEngine.stats();
    expect(stats.PENDING).toBeGreaterThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(3000);

    const total = demoEngine.list().length;
    stats = demoEngine.stats();
    expect(stats.PENDING + stats.CONFIRMED + stats.FAILED).toBe(total);
  });

  it('уведомляет подписчиков при изменениях', async () => {
    const cb = vi.fn();
    const off = demoEngine.onChange(cb);

    const movie = demoEngine.movies().data[0];
    const seat = freeSeat(demoEngine.seatMap(movie.id));
    demoEngine.create({ movieId: movie.id, customerName: 'Подписка', seats: [seat] });

    expect(cb).toHaveBeenCalledTimes(1); // создание PENDING

    await vi.advanceTimersByTimeAsync(3000);
    expect(cb).toHaveBeenCalledTimes(2); // вердикт «воркера»

    off();
    demoEngine.create({
      movieId: movie.id,
      customerName: 'После отписки',
      seats: [freeSeat(demoEngine.seatMap(movie.id))],
    });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('неизвестный фильм — ошибка', () => {
    expect(() =>
      demoEngine.create({ movieId: 'нет-такого', customerName: 'X', seats: ['1-1'] }),
    ).toThrow();
  });
});
