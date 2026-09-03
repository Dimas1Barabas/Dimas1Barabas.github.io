import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from './demoEngine';

/** Движок демо-режима должен повторять контракт реального API + поведение Go-воркера */
describe('demoEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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

  it('create: PENDING с правильной суммой, затем вердикт «воркера»', async () => {
    const movie = demoEngine.movies().data[0];
    const booking = demoEngine.create({
      movieId: movie.id,
      customerName: 'Тест',
      seats: 3,
    });

    expect(booking.status).toBe('PENDING');
    expect(booking.totalRub).toBe(movie.priceRub * 3);
    expect(booking.message).toBeNull();

    const inList = demoEngine.list()[0];
    expect(inList.id).toBe(booking.id);

    // «воркер» срабатывает в окне 1,2–2,8 c
    await vi.advanceTimersByTimeAsync(3000);
    const done = demoEngine.list()[0];
    expect(['CONFIRMED', 'FAILED']).toContain(done.status);
    expect(done.message).toBeTruthy();
    expect(done.processedBy).toBe('go-worker (демо)');
    expect(done.processedAt).toBeTruthy();
  });

  it('статистика сходится со списком', async () => {
    const movie = demoEngine.movies().data[0];
    demoEngine.create({ movieId: movie.id, customerName: 'Стат', seats: 1 });
    demoEngine.create({ movieId: movie.id, customerName: 'Стат', seats: 2 });

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
    demoEngine.create({ movieId: movie.id, customerName: 'Подписка', seats: 1 });

    expect(cb).toHaveBeenCalledTimes(1); // создание PENDING

    await vi.advanceTimersByTimeAsync(3000);
    expect(cb).toHaveBeenCalledTimes(2); // вердикт «воркера»

    off();
    demoEngine.create({ movieId: movie.id, customerName: 'После отписки', seats: 1 });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('неизвестный фильм — ошибка', () => {
    expect(() =>
      demoEngine.create({ movieId: 'нет-такого', customerName: 'X', seats: 1 }),
    ).toThrow();
  });
});
