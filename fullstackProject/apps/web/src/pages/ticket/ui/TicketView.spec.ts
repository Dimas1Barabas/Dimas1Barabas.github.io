import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import type { SeatMap } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import TicketView from '@/pages/ticket/ui/TicketView.vue';

/** Экран QR-билетов: демо-режим, настоящий роутер (маршрут /ticket/:bookingId) */

function freeSeats(map: SeatMap, count: number): string[] {
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

/** оплаченная демо-бронь, доведённая «воркером» до CONFIRMED */
async function createConfirmed(seatCount: number) {
  const movie = demoEngine.movies().data[0];
  const session = movie.sessions.find(
    (s) => Date.parse(s.startsAt) > Date.now(),
  );
  if (!session) throw new Error('нет будущих сеансов в демо-фикстуре');
  const seats = freeSeats(demoEngine.seatMap(session.id), seatCount);
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
  const booking = demoEngine.create({
    sessionId: session.id,
    customerName: 'Билетчик',
    seats,
  });
  demoEngine.pay(booking.id);
  await vi.advanceTimersByTimeAsync(3000);
  randomSpy.mockRestore();
  expect(booking.status).toBe('CONFIRMED');
  return booking;
}

async function mountTicket(bookingId: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAppStore().mode = 'demo';
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { render: () => null } },
      { path: '/bookings', name: 'bookings', component: { render: () => null } },
      { path: '/ticket/:bookingId', name: 'ticket', component: TicketView },
    ],
  });
  await router.push(`/ticket/${bookingId}`);
  await router.isReady();
  const wrapper = mount(TicketView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('TicketView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    // Teleport уносит оверлей в body — чистим за собой
    document.body.innerHTML = '';
  });

  it('CONFIRMED: карточка на каждое место с QR, рядом и гостем', async () => {
    const booking = await createConfirmed(2);
    const wrapper = await mountTicket(booking.id);

    const cards = wrapper.findAll('.ticket-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.text()).toContain(booking.movieTitle);
    expect(cards[0]!.text()).toContain('Ряд');
    expect(cards[0]!.text()).toContain('Билетчик');
    expect(cards[0]!.text()).toContain('TK-');
    expect(cards[0]!.find('svg.qr')).toBeTruthy();
  });

  it('клик по QR — полноэкранный «вход в зал», Esc закрывает', async () => {
    const booking = await createConfirmed(1);
    const wrapper = await mountTicket(booking.id);

    expect(document.querySelector('.ticket-fullscreen')).toBeNull();

    await wrapper.find('.ticket-card__qr').trigger('click');
    await flushPromises();

    const fullscreen = document.querySelector('.ticket-fullscreen');
    expect(fullscreen).not.toBeNull();
    expect(fullscreen!.querySelector('svg.qr')).toBeTruthy();
    expect(fullscreen!.textContent).toContain('место');

    fullscreen!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(document.querySelector('.ticket-fullscreen')).toBeNull();
  });

  it('бронь не подтверждена — объяснение и путь назад', async () => {
    const movie = demoEngine.movies().data[0];
    const session = movie.sessions.find(
      (s) => Date.parse(s.startsAt) > Date.now(),
    )!;
    const seats = freeSeats(demoEngine.seatMap(session.id), 1);
    const pending = demoEngine.create({
      sessionId: session.id,
      customerName: 'Рано',
      seats,
    });

    const wrapper = await mountTicket(pending.id);

    expect(wrapper.text()).toContain('подтверждённой');
    expect(wrapper.find('.ticket-card').exists()).toBe(false);
    expect(wrapper.text()).toContain('К бронированиям');
  });
});
