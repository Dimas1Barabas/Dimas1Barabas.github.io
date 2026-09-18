import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PAYMENT_TIMEOUT_MS, demoEngine } from '@/shared/api/demo-engine';
import type { SeatMap } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useBookingsStore } from '@/entities/booking/model/store';
import PaymentView from '@/pages/payment/ui/PaymentView.vue';

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

  describe('промокод', () => {
    /** применяет код через поле на экране (как покупатель) */
    async function applyCode(wrapper: Awaited<ReturnType<typeof mountPay>>, code: string) {
      await wrapper.find('.pay-promo__input').setValue(code);
      await wrapper.find('.pay-promo .btn').trigger('click');
      await flushPromises();
    }

    it('превью: зачёркнутая база, скидка и новый итог в кнопке', async () => {
      const booking = createUnpaid(); // первый фильм афиши — 450 ₽
      const wrapper = await mountPay(booking.id);

      await applyCode(wrapper, 'cine10');

      const applied = wrapper.find('.promo-applied');
      expect(applied.exists()).toBe(true);
      expect(applied.text()).toContain('CINE10');
      // 450 − 10% = 45 скидка, 405 к оплате
      expect(applied.find('.promo-applied__base').text()).toContain('450');
      expect(applied.find('.promo-applied__discount').text()).toContain('45');
      expect(wrapper.find('.pay-actions .btn').text()).toContain('405');
    });

    it('неизвестный и истёкший код — подсказки без применения', async () => {
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      await applyCode(wrapper, 'NOPE');
      expect(wrapper.text()).toContain('Промокод не найден');
      expect(wrapper.find('.promo-applied').exists()).toBe(false);

      await applyCode(wrapper, 'expired5');
      expect(wrapper.text()).toContain('Срок действия промокода истёк');
      expect(wrapper.find('.promo-applied').exists()).toBe(false);
    });

    it('«Убрать» возвращает базовую сумму', async () => {
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      await applyCode(wrapper, 'cine10');
      await wrapper.find('.promo-applied .btn').trigger('click');
      await flushPromises();

      expect(wrapper.find('.promo-applied').exists()).toBe(false);
      expect(wrapper.find('.pay-actions .btn').text()).toContain('450');
    });

    it('код исчерпали между применением и оплатой: подсказка, бронь payable', async () => {
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      await applyCode(wrapper, 'summer300'); // 2 из 3 — превью проходит
      expect(wrapper.find('.promo-applied').exists()).toBe(true);

      // «другой зритель» успевает забрать последнюю активацию
      const session = demoEngine.movies().data[0].sessions[0];
      const rival = demoEngine.create({
        sessionId: session.id,
        customerName: 'Соперник',
        seats: ['8-10'],
      });
      demoEngine.pay(rival.id, 'SUMMER300');

      await wrapper.find('.pay-actions .btn').trigger('click');
      await flushPromises();

      expect(wrapper.text()).toContain('Лимит активаций промокода исчерпан');
      expect(wrapper.find('.promo-applied').exists()).toBe(false);
      // транзакция откатилась: сумма базовая, бронь всё ещё ждёт оплаты
      expect(wrapper.find('.pay-actions .btn').text()).toContain('450');
      expect(wrapper.text()).toContain('оплата в течение');
    });

    it('оплата с промокодом: вердикт со скидочной суммой', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      await applyCode(wrapper, 'cine10');
      await wrapper.find('.pay-actions .btn').trigger('click');
      await flushPromises();

      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();
      randomSpy.mockRestore();

      expect(wrapper.text()).toContain('Оплата прошла');
      // 405 ₽ — уже скидочная сумма в сообщении «воркера»
      expect(wrapper.text()).toContain('405');
    });
  });
});
