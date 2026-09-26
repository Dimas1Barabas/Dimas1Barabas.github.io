/**
 * Демо-движок: напоминания «скоро сеанс» — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';

describe('демо-движок: напоминания «скоро сеанс»', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('CONFIRMED-вердикт взводит письмо в пределах clamp-окна', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const movie = demoEngine.movies().data[0];
    const session = movie.sessions.at(-1)!;
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: ['5-7'],
    });
    demoEngine.pay(booking.id);

    await vi.advanceTimersByTimeAsync(3_000); // вердикт воркера
    expect(booking.status).toBe('CONFIRMED');
    expect(demoEngine.reminders()).toHaveLength(0); // письмо ждёт окна

    await vi.advanceTimersByTimeAsync(60_000); // потолок clamp — письмо ушло
    const [letter] = demoEngine.reminders();
    expect(letter).toMatchObject({
      bookingId: booking.id,
      userId: 'demo-guest',
      movieTitle: movie.title,
      hall: session.hall,
      seats: ['5-7'],
    });
    randomSpy.mockRestore();
  });

  it('сеанс уже прошёл — письмо не взводится', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const movie = demoEngine.movies().data[0];
    const session = movie.sessions.at(-1)!;
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: ['5-7'],
    });
    // «сеанс начался, пока платили» — гард движка обязан отказать
    booking.sessionAt = '2020-01-01T00:00:00.000Z';
    demoEngine.pay(booking.id);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(booking.status).toBe('CONFIRMED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(demoEngine.reminders()).toHaveLength(0);
    randomSpy.mockRestore();
  });

  it('отмена до письма гасит таймер; REFUND_FAILED-откат — нет', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const movie = demoEngine.movies().data[0];
    const session = movie.sessions.at(-1)!;
    const first = demoEngine.create({
      sessionId: session.id,
      customerName: 'Первый',
      seats: ['5-7'],
    });
    demoEngine.pay(first.id);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(first.status).toBe('CONFIRMED');

    demoEngine.cancel(first.id); // успех возврата (random 0.1 < 0.9)
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(demoEngine.reminders()).toHaveLength(0); // письмо погашено

    // вторая бронь: возврат ОТКАЗАН — бронь снова CONFIRMED, письмо живёт
    const second = demoEngine.create({
      sessionId: session.id,
      customerName: 'Второй',
      seats: ['5-8'],
    });
    demoEngine.pay(second.id);
    await vi.advanceTimersByTimeAsync(3_000);
    demoEngine.cancel(second.id);
    randomSpy.mockReturnValue(0.95); // REFUND_SUCCESS_RATE = 0.9 → отказ
    await vi.advanceTimersByTimeAsync(3_000);
    expect(second.status).toBe('CONFIRMED'); // откат саги

    await vi.advanceTimersByTimeAsync(60_000);
    expect(demoEngine.reminders()).toHaveLength(1);
    expect(demoEngine.reminders()[0].bookingId).toBe(second.id);
    randomSpy.mockRestore();
  });

  it('reset чистит таймеры и историю писем', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const movie = demoEngine.movies().data[0];
    const session = movie.sessions.at(-1)!;
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: ['5-7'],
    });
    demoEngine.pay(booking.id);
    await vi.advanceTimersByTimeAsync(3_000); // CONFIRMED, письмо взведено

    demoEngine.reset();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(demoEngine.reminders()).toHaveLength(0); // таймер не выжил
    randomSpy.mockRestore();
  });
});

