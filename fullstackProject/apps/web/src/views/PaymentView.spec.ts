import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PAYMENT_TIMEOUT_MS, demoEngine } from '../api/demoEngine';
import type { SeatMap } from '../api/types';
import { useAppStore } from '../stores/app';
import { useBookingsStore } from '../stores/bookings';
import PaymentView from './PaymentView.vue';

/** Экран оплаты: демо-режим, настоящий роутер (маршрут /pay/:bookingId) */

/** первое свободное место — чтобы не зависеть от посева занятости */
function freeSeat(map: SeatMap): string {
  for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) return code;
    }
  }
  throw new Error('зал заполнен');
}

/** неоплаченная демо-бронь — как если бы её только что создали из модалки */
function createUnpaid() {
  const session = demoEngine.movies().data[0].sessions[0];
  const seat = freeSeat(demoEngine.seatMap(session.id));
  return demoEngine.create({ sessionId: session.id, customerName: 'Плательщик', seats: [seat] });
}

async function mountPay(bookingId: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAppStore().mode = 'demo';
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { render: () => null } },
      { path: '/my', name: 'my', component: { render: () => null } },
      { path: '/pay/:bookingId', name: 'pay', component: PaymentView },
    ],
  });
  await router.push(`/pay/${bookingId}`);
  await router.isReady();
  const wrapper = mount(PaymentView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('PaymentView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('активная бронь: сводка, сумма и таймер окна оплаты', async () => {
    const booking = createUnpaid();
    const wrapper = await mountPay(booking.id);

    expect(wrapper.text()).toContain(booking.movieTitle);
    expect(wrapper.text()).toContain('К оплате');
    expect(wrapper.text()).toContain(`${booking.totalRub.toLocaleString('ru-RU')} ₽`);
    // окно оплаты демо — 2 минуты
    expect(wrapper.find('.pay-timer').text()).toContain('02:00');

    const payBtn = wrapper.find('.pay-actions .btn');
    expect(payBtn.attributes('disabled')).toBeUndefined();
    expect(payBtn.text()).toContain('Оплатить');
  });

  it('таймер тикает: минута прошла — «01:00»', async () => {
    const booking = createUnpaid();
    const wrapper = await mountPay(booking.id);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();

    expect(wrapper.find('.pay-timer').text()).toContain('01:00');
  });

  it('ноль таймера не флипает статус: кнопка выключена, «проверяем»', async () => {
    const booking = createUnpaid();
    const wrapper = await mountPay(booking.id);
    const store = useBookingsStore();

    // дедлайн прошёл, а вердикт брокера ещё в пути (гонка live-режима):
    // сами EXPIRED не ставим — только блокируем оплату и «проверяем»
    store.bookings[0].expiresAt = new Date(Date.now() - 60_000).toISOString();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(wrapper.find('.pay-timer').text()).toContain('время вышло');
    expect(wrapper.find('.pay-actions .btn').attributes('disabled')).toBeDefined();
    expect(store.bookings[0].status).toBe('PENDING_PAYMENT');
  });

  it('клик «Оплатить»: PENDING → вердикт воркера → успех', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1); // оплата проходит
    const booking = createUnpaid();
    const wrapper = await mountPay(booking.id);

    await wrapper.find('.pay-actions .btn').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Проводим платёж');

    await vi.advanceTimersByTimeAsync(3000);
    await flushPromises();
    randomSpy.mockRestore();

    expect(wrapper.text()).toContain('Оплата прошла');
    expect(wrapper.text()).toContain('Мои билеты');
  });

  it('неоплаченная истекла: экран предлагает выбрать места заново', async () => {
    const booking = createUnpaid();
    const wrapper = await mountPay(booking.id);

    await vi.advanceTimersByTimeAsync(DEMO_PAYMENT_TIMEOUT_MS + 1000);
    await flushPromises();

    expect(wrapper.text()).toContain('Время оплаты истекло');
    expect(wrapper.text()).toContain('Выбрать места заново');
  });

  it('deep-link на неизвестную бронь — «не найдена»', async () => {
    const wrapper = await mountPay('нет-такой');

    expect(wrapper.text()).toContain('Бронь не найдена');
  });
});
