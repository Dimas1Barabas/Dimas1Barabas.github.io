import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import { useMoviesStore } from '@/entities/movie/model/movies.store';

describe('movies store: демо-режим', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
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
});
