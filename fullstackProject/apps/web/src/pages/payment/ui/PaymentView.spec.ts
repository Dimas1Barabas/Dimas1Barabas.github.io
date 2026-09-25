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

/** неоплаченная демо-бронь — как если бы её только что создали из модалки.
 *  Сеанс — ближайший будущий: сумма приехала от Тарификатора (время суток
 *  и спрос — факторы), арифметика тестов выводится из booking.totalRub */
function createUnpaid() {
  const movie = demoEngine.movies().data[0];
  const session =
    movie.sessions.find((x) => Date.parse(x.startsAt) > Date.now()) ??
    movie.sessions[0];
  const seat = freeSeat(demoEngine.seatMap(session.id));
  return demoEngine.create({ sessionId: session.id, customerName: 'Плательщик', seats: [seat] });
}

/** 10% CINE10 от суммы — как promoDiscount движка (round) */
const cine10 = (total: number) => Math.round((total * 10) / 100);

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
      // скидка 10% и итог — от суммы брони (цена места — от Тарификатора)
      const discount = cine10(booking.totalRub);
      expect(applied.find('.promo-applied__base').text()).toContain(String(booking.totalRub));
      expect(applied.find('.promo-applied__discount').text()).toContain(String(discount));
      expect(wrapper.find('.pay-actions .btn').text()).toContain(String(booking.totalRub - discount));
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
      expect(wrapper.find('.pay-actions .btn').text()).toContain(String(booking.totalRub));
    });

    it('код исчерпали между применением и оплатой: подсказка, бронь payable', async () => {
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      await applyCode(wrapper, 'summer300'); // 2 из 3 — превью проходит
      expect(wrapper.find('.promo-applied').exists()).toBe(true);

      // «другой зритель» успевает забрать последнюю активацию
      const first = demoEngine.movies().data[0];
      const session =
        first.sessions.find((x) => Date.parse(x.startsAt) > Date.now()) ??
        first.sessions[0];
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
      expect(wrapper.find('.pay-actions .btn').text()).toContain(String(booking.totalRub));
      expect(wrapper.text()).toContain('оплата в течение');
    });

    it('оплата с промокодом: вердикт со скидочной суммой', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);
      // сумма до оплаты: pay() мутирует бронь на месте (итог — в сообщении)
      const total = booking.totalRub;

      await applyCode(wrapper, 'cine10');
      await wrapper.find('.pay-actions .btn').trigger('click');
      await flushPromises();

      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();
      randomSpy.mockRestore();

      expect(wrapper.text()).toContain('Оплата прошла');
      // скидочная сумма — уже в сообщении «воркера»
      expect(wrapper.text()).toContain(String(total - cine10(total)));
    });
  });

  describe('бонусы', () => {
    /** включает списание чекбоксом (по умолчанию — максимум) */
    async function enableBonus(wrapper: Awaited<ReturnType<typeof mountPay>>) {
      await wrapper.find('.pay-bonus__toggle input').setValue(true);
      await flushPromises();
    }

    it('блок виден с балансом сида; чекбокс включает максимум', async () => {
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      const block = wrapper.find('.pay-bonus');
      expect(block.exists()).toBe(true);
      expect(block.text()).toContain('350 на счету');
      // до включения итог не меняется
      expect(wrapper.find('.pay-actions .btn').text()).toContain(String(booking.totalRub));

      await enableBonus(wrapper);

      // лимит — половина чека (цена места — от Тарификатора)
      const limit = Math.floor(booking.totalRub / 2);
      expect((wrapper.find('.pay-bonus__input').element as HTMLInputElement).value).toBe(String(limit));
      expect(wrapper.find('.pay-actions .btn').text()).toContain(String(booking.totalRub - limit));
    });

    it('ручной ввод зажимается потолком половины чека', async () => {
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      await enableBonus(wrapper);
      await wrapper.find('.pay-bonus__input').setValue(String(booking.totalRub));
      await flushPromises();

      // больше лимита — спишем только лимит
      const limit = Math.floor(booking.totalRub / 2);
      expect(wrapper.find('.pay-actions .btn').text()).toContain(String(booking.totalRub - limit));
    });

    it('можно списать меньше максимума — итог пересчитывается', async () => {
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      await enableBonus(wrapper);
      await wrapper.find('.pay-bonus__input').setValue('100');
      await flushPromises();

      expect(wrapper.find('.pay-actions .btn').text()).toContain(String(booking.totalRub - 100));
    });

    it('промо сужает потолок бонусов: половина от суммы со скидкой', async () => {
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);

      // CINE10: сначала скидка, потом половина остатка — потолок бонусов
      await wrapper.find('.pay-promo__input').setValue('cine10');
      await wrapper.find('.pay-promo .btn').trigger('click');
      await flushPromises();
      await enableBonus(wrapper);

      const afterPromo = booking.totalRub - cine10(booking.totalRub);
      const limit = Math.floor(afterPromo / 2);
      expect((wrapper.find('.pay-bonus__input').element as HTMLInputElement).value).toBe(String(limit));
      expect(wrapper.find('.pay-actions .btn').text()).toContain(String(afterPromo - limit));
    });

    it('оплата с бонусами: вердикт с финальной суммой, счёт списан', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const booking = createUnpaid();
      const wrapper = await mountPay(booking.id);
      // сумма до оплаты: pay() мутирует бронь на месте (итог — в сообщении)
      const total = booking.totalRub;

      await enableBonus(wrapper);
      await wrapper.find('.pay-bonus__input').setValue('200');
      await wrapper.find('.pay-actions .btn').trigger('click');
      await flushPromises();

      await vi.advanceTimersByTimeAsync(3000);
      await flushPromises();
      randomSpy.mockRestore();

      expect(wrapper.text()).toContain('Оплата прошла');
      // финальная сумма — в сообщении «воркера»
      const final = total - 200;
      expect(wrapper.text()).toContain(String(final));
      // 350 − 200 + кэшбэк floor(final × 5%)
      expect(demoEngine.myBonuses().balance).toBe(150 + Math.floor(final * 0.05));
    });
  });
});
