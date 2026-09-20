import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { Ticket } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useTicketsStore } from '@/entities/ticket/model/tickets.store';

vi.mock('@/shared/api/client', async (importOriginal) => {
  // ApiError оставляем настоящим; мокаем только сеть
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      bookingTickets: vi.fn(),
    },
  };
});

const ticketFixture = (overrides: Partial<Ticket> = {}): Ticket => ({
  bookingId: 'b-1',
  seat: '5-7',
  ticketNo: 'TK-59U3V4',
  signature: '2e0254421e0f61336e75bd1c6af05d99',
  movieTitle: 'Рекурсия',
  movieHue: 275,
  movieGenreIcon: '🌀',
  sessionAt: new Date(Date.now() + 86_400_000).toISOString(),
  hall: 'IMAX',
  customerName: 'Дмитрий',
  ...overrides,
});

/** демо-бронь, доведённая «воркером» до CONFIRMED (fake-таймеры) */
async function demoConfirmedBooking() {
  const movie = demoEngine.movies().data[0];
  const session = movie.sessions.find(
    (s) => Date.parse(s.startsAt) > Date.now(),
  );
  if (!session) throw new Error('нет будущих сеансов в демо-фикстуре');
  const map = demoEngine.seatMap(session.id);
  const seat = `${map.layout.rows}-${map.layout.seatsPerRow}`; // дальний угол
  const free = !map.occupied.includes(seat) ? seat : undefined;
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
  const booking = demoEngine.create({
    sessionId: session.id,
    customerName: 'Стор Билетов',
    seats: free ? [free] : [`${map.layout.rows}-1`],
  });
  demoEngine.pay(booking.id);
  await vi.advanceTimersByTimeAsync(3000);
  randomSpy.mockRestore();
  expect(booking.status).toBe('CONFIRMED');
  return booking;
}

describe('tickets store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    demoEngine.reset();
    vi.mocked(api.bookingTickets).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('демо: билеты брони свежими копиями', async () => {
    useAppStore().mode = 'demo';
    const booking = await demoConfirmedBooking();

    const store = useTicketsStore();
    await store.load(booking.id);

    expect(store.bookingId).toBe(booking.id);
    expect(store.tickets).toHaveLength(booking.seats.length);
    // копии: мутация стора не трогает движок
    store.tickets[0]!.signature = 'HACKED';
    expect(demoEngine.tickets(booking.id)[0]!.signature).not.toBe('HACKED');
  });

  it('демо: бронь не подтверждена — текст ошибки из ApiError', async () => {
    useAppStore().mode = 'demo';
    const movie = demoEngine.movies().data[0];
    const map = demoEngine.seatMap(movie.sessions[0]!.id);
    const seat = `${map.layout.rows}-${map.layout.seatsPerRow}`;
    const booking = demoEngine.create({
      sessionId: movie.sessions[0]!.id,
      customerName: 'Рано',
      seats: [map.occupied.includes(seat) ? `${map.layout.rows}-1` : seat],
    });

    const store = useTicketsStore();
    await store.load(booking.id);

    expect(store.tickets).toEqual([]);
    expect(store.error).toContain('подтверждённой');
  });

  it('live: загрузка через API, clear сбрасывает', async () => {
    useAppStore().mode = 'live';
    const list = [ticketFixture()];
    vi.mocked(api.bookingTickets).mockResolvedValue(list);

    const store = useTicketsStore();
    await store.load('b-1');
    expect(api.bookingTickets).toHaveBeenCalledWith('b-1');
    expect(store.tickets).toEqual(list);

    store.clear();
    expect(store.tickets).toEqual([]);
    expect(store.bookingId).toBeNull();
  });

  it('live: ошибка загрузки — текст в state, без броска', async () => {
    useAppStore().mode = 'live';
    vi.mocked(api.bookingTickets).mockRejectedValue(new Error('offline'));

    const store = useTicketsStore();
    await expect(store.load('b-1')).resolves.toBeUndefined();
    expect(store.error).toBe('offline');
    expect(store.loading).toBe(false);
  });
});
