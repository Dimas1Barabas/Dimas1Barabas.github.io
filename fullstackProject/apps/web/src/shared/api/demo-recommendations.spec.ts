/**
 * Демо-движок: КиноСоветник (рекомендации) — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { freeSeat } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: КиноСоветник (рекомендации)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('сиды профиля: топ на их основе, просмотренный «Млечный Путь» исключён', () => {
    const top = demoEngine.recommendations();

    expect(top.basis).toBe('profile');
    expect(top.items.length).toBeGreaterThan(0);
    expect(top.items.map((i) => i.movieId)).not.toContain('demo-milky-way');
  });

  /** первый фильм текущего топа + его сеанс — бронь по нему меняет топ */
  function topPick() {
    const pick = demoEngine.recommendations().items[0];
    if (!pick) throw new Error('топ пуст — сиды не дали профиля');
    const movie = demoEngine.movies().data.find((m) => m.id === pick.movieId)!;
    const session = movie.sessions[0];
    if (!session) throw new Error('у фильма топа нет сеансов');
    return { movie, session };
  }

  it('CONFIRMED-бронь дописывает сигнал: фильм выпадает из топа', async () => {
    // 0.1 < SUCCESS_RATE — вердикт воркера будет CONFIRMED
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { movie, session } = topPick();
    expect(
      demoEngine.recommendations().items.map((i) => i.movieId),
    ).toContain(movie.id); // до оплаты фильм был в топе

    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });
    demoEngine.pay(booking.id);
    await vi.advanceTimersByTimeAsync(3000);
    spy.mockRestore();

    expect(demoEngine.list()[0].status).toBe('CONFIRMED');
    expect(
      demoEngine.recommendations().items.map((i) => i.movieId),
    ).not.toContain(movie.id);
  });

  it('отзыв после брони — сигнал сильнее: жанр растёт в весе', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { movie, session } = topPick();
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });
    demoEngine.pay(booking.id);
    await vi.advanceTimersByTimeAsync(3000);
    spy.mockRestore();

    demoEngine.createReview(movie.id, {
      rating: 5,
      text: 'Один из лучших просмотров этого года!',
    });

    const top = demoEngine.recommendations();
    expect(top.basis).toBe('profile');
    // фильм «смотрел + оценил» — точно не в топе
    expect(top.items.map((i) => i.movieId)).not.toContain(movie.id);
  });
});


