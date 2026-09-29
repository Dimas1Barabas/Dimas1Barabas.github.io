/** movies store: демо-режим (движок, зрители, avoid-выбор). Live-карта по WebSocket — в movies.store-live.spec.ts */
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import { useMoviesStore } from '@/entities/movie/model/movies.store';

describe('movies store: демо-режим', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.restoreAllMocks(); // Math.random-шпионы не текут в соседние тесты
    demoEngine.reset();
    useAppStore().mode = 'demo';
  });

  it('грузит из движка и помечает источник', async () => {
    const movies = useMoviesStore();
    await movies.load();

    expect(movies.movies.length).toBeGreaterThan(0);
    expect(['db', 'cache']).toContain(movies.source);
    expect(movies.error).toBeNull();
  });

  it('грузит карту зала сеанса', async () => {
    const movies = useMoviesStore();
    await movies.load();
    await movies.loadSeats(movies.movies[0].sessions[0].id);

    expect(movies.seatMap).not.toBeNull();
    expect(movies.seatMap!.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(movies.seatMap!.free).toBeGreaterThan(0);
  });

  it('демо-зрители: движок занимает место, пока поток жив', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const sid = movies.movies[0].sessions[0].id;
    await movies.loadSeats(sid);
    const before = movies.seatMap!.occupied.length;

    vi.spyOn(Math, 'random').mockReturnValue(0.99); // всегда «занять»
    movies.startSeatStream(sid);
    await vi.advanceTimersByTimeAsync(16_000); // максимум интервала 15 c

    expect(movies.seatMap!.occupied.length).toBe(before + 1);
    movies.stopSeatStream();
  });

  it('stopSeatStream глушит таймер зрителей', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const sid = movies.movies[0].sessions[0].id;
    await movies.loadSeats(sid);

    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    movies.startSeatStream(sid);
    await vi.advanceTimersByTimeAsync(16_000);
    movies.stopSeatStream();

    const frozen = demoEngine.seatMap(sid).occupied.length;
    await vi.advanceTimersByTimeAsync(32_000);
    expect(demoEngine.seatMap(sid).occupied.length).toBe(frozen);
  });

  it('avoid-выбор не занимается «зрителем»', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const sid = movies.movies[0].sessions[0].id;
    await movies.loadSeats(sid);
    const map = movies.seatMap!;

    // единственное разрешённое место — первый свободный код, остальное avoid
    const occupied = new Set(map.occupied);
    let allowed = '';
    const avoid: string[] = [];
    for (let row = 1; row <= map.layout.rows; row++) {
      for (let num = 1; num <= map.layout.seatsPerRow; num++) {
        const code = `${row}-${num}`;
        if (occupied.has(code)) continue;
        if (!allowed) allowed = code;
        else avoid.push(code);
      }
    }

    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    movies.startSeatStream(sid, () => avoid);
    await vi.advanceTimersByTimeAsync(16_000);

    const after = movies.seatMap!;
    expect(after.occupied).toContain(allowed);
    expect(after.occupied.length).toBe(map.occupied.length + 1);
    movies.stopSeatStream();
  });
});
