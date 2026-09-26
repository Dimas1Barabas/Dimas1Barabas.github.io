/**
 * Демо-движок: живая карта — другие зрители — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { freeSeat, firstSession } from '@/shared/api/demo-spec-helpers';

describe('demo: живая карта — другие зрители', () => {
  beforeEach(() => {
    demoEngine.reset();
  });

  it('занимает свободное место и уведомляет слушателей', () => {
    const { session } = firstSession();
    const before = demoEngine.seatMap(session.id);
    const notified = vi.fn();
    demoEngine.onChange(notified);

    // первая кость Math.random — ветвь (≥0.3 — занять), вторая — выбор места
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValue(0.5);

    expect(demoEngine.simulateOtherViewer(session.id, [])).toBe('taken');
    const after = demoEngine.seatMap(session.id);
    expect(after.occupied.length).toBe(before.occupied.length + 1);
    expect(notified).toHaveBeenCalled();
  });

  it('уважает avoid: выбор локального пользователя неприкосновенен', () => {
    const { session } = firstSession();
    const map = demoEngine.seatMap(session.id);
    const allowed = freeSeat(map);
    const occupied = new Set(map.occupied);
    const avoid: string[] = [];
    for (let row = 1; row <= map.layout.rows; row++) {
      for (let num = 1; num <= map.layout.seatsPerRow; num++) {
        const code = `${row}-${num}`;
        if (!occupied.has(code) && code !== allowed) avoid.push(code);
      }
    }

    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValue(0.99);

    expect(demoEngine.simulateOtherViewer(session.id, avoid)).toBe('taken');
    const after = demoEngine.seatMap(session.id);
    expect(after.occupied).toContain(allowed);
    expect(after.occupied.length).toBe(map.occupied.length + 1);
  });

  it('release-ветвь освобождает только место симулянта — сиды на месте', () => {
    const { session } = firstSession();
    const before = demoEngine.seatMap(session.id).occupied;

    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValue(0.5);
    demoEngine.simulateOtherViewer(session.id, []);
    expect(demoEngine.seatMap(session.id).occupied.length).toBe(before.length + 1);

    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValue(0.5);
    expect(demoEngine.simulateOtherViewer(session.id, [])).toBe('released');
    expect(demoEngine.seatMap(session.id).occupied).toEqual(before);
  });

  it('аншлаг и пустая карта зрителей → none без мутаций', () => {
    const FULL = 'demo-recursion-s1';
    const before = demoEngine.seatMap(FULL).occupied;

    const dice = vi.spyOn(Math, 'random');
    dice.mockReturnValueOnce(0.99); // занять — но свободных мест нет
    expect(demoEngine.simulateOtherViewer(FULL, [])).toBe('none');
    dice.mockReturnValueOnce(0.1); // освобождать нечего
    expect(demoEngine.simulateOtherViewer(FULL, [])).toBe('none');
    expect(demoEngine.seatMap(FULL).occupied).toEqual(before);
  });

  it('reset вычищает места зрителей', () => {
    const { session } = firstSession();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValue(0.5);
    demoEngine.simulateOtherViewer(session.id, []);

    demoEngine.reset();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1);
    expect(demoEngine.simulateOtherViewer(session.id, [])).toBe('none');
  });
});

