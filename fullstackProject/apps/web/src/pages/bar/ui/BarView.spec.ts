import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useAppStore } from '@/shared/api/app-mode';
import { useBarStore } from '@/entities/bar/model/store';
import { demoEngine } from '@/shared/api/demo-engine';
import { firstFreeSeats, seatPriceOf, firstSession } from '@/shared/api/demo-spec-helpers';
import BarView from '@/pages/bar/ui/BarView.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div>home</div>' } },
    { path: '/login', component: { template: '<div>login</div>' } },
    { path: '/bar', component: BarView },
  ],
});

function mountView(mode: 'demo' | 'live') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const appStore = useAppStore();
  appStore.mode = mode;
  const wrapper = mount(BarView, { global: { plugins: [pinia, router] } });
  return { wrapper, bar: useBarStore() };
}

/** флуш промисов загрузки onMounted + перерисовка шаблона */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await nextTick();
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  demoEngine.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** CONFIRMED-бронь на count мест — траты гостя переваливают порог Зрителя */
async function confirmBigBooking(seatsCount: number): Promise<void> {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
  const { session } = firstSession();
  const seats = firstFreeSeats(demoEngine.seatMap(session.id), seatsCount);
  const booking = demoEngine.create({
    sessionId: session.id,
    customerName: 'Тест',
    seats,
  });
  demoEngine.pay(booking.id);
  await vi.advanceTimersByTimeAsync(3000);
  spy.mockRestore();
  expect(seatPriceOf(session.id) * seatsCount).toBeGreaterThanOrEqual(3000);
}

describe('BarView: страница «Кинобар»', () => {
  it('демо: каталог по категориям, дефицит воды виден бейджем', async () => {
    const { wrapper } = mountView('demo');
    await router.isReady();
    await flush();
    await flush();

    expect(wrapper.text()).toContain('Попкорн');
    expect(wrapper.text()).toContain('Напитки');
    expect(wrapper.text()).toContain('Комбо');
    // вода с дефицитом — «осталось 3»
    const low = wrapper.find('[data-testid="bar-low-stock"]');
    expect(low.exists()).toBe(true);
    expect(low.text()).toContain('3');
  });

  it('корзина и оформление: +/−, сумма и заказ NEW в «моих»', async () => {
    const { wrapper, bar } = mountView('demo');
    await router.isReady();
    await flush();
    await flush();

    await wrapper.find('[data-testid="bar-inc-popcorn-salted"]').trigger('click');
    await wrapper.find('[data-testid="bar-inc-popcorn-salted"]').trigger('click');
    await wrapper.find('[data-testid="bar-inc-cola-05"]').trigger('click');

    expect(wrapper.find('[data-testid="bar-qty-popcorn-salted"]').text()).toBe('2');
    expect(wrapper.find('[data-testid="bar-cart-total"]').text()).toBe('860 ₽');
    // Новичок: скидки нет — строки про уровень и пересчёта не появляется
    expect(wrapper.find('[data-testid="bar-cart-discount"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="bar-submit"]').text()).toContain('860 ₽');

    await wrapper.find('[data-testid="bar-submit"]').trigger('click');
    await flush();
    await flush();

    expect(bar.orders).toHaveLength(1);
    expect(bar.orders[0].status).toBe('NEW');
    expect(bar.orders[0].items).toHaveLength(2);
    expect(wrapper.find('[data-testid="bar-order-new"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="bar-notice"]').text()).toContain('оформлен');
    bar.stopWatching();
  });

  it('отмена доступна на NEW и уходит после выдачи', async () => {
    const { wrapper, bar } = mountView('demo');
    await router.isReady();
    await flush();
    await flush();

    await wrapper.find('[data-testid="bar-inc-combo-classic"]').trigger('click');
    await wrapper.find('[data-testid="bar-submit"]').trigger('click');
    await flush();
    await flush();
    const id = bar.orders[0].id;

    // NEW: кнопка отмены есть
    expect(wrapper.find(`[data-testid="bar-cancel-${id}"]`).exists()).toBe(true);

    // Бармен довёл до выданного — кнопки нет, статус PICKED_UP
    await vi.advanceTimersByTimeAsync(12_000);
    await bar.refreshOrders(); // статус уже в движке — тащим в стор напрямую
    await flush();
    expect(bar.orders[0].status).toBe('PICKED_UP');
    expect(wrapper.find(`[data-testid="bar-cancel-${id}"]`).exists()).toBe(false);
    expect(wrapper.find('[data-testid="bar-order-picked_up"]').exists()).toBe(true);
  });

  it('live без сессии: каталог показан, оформления нет', async () => {
    // живой API в юнит-стенде недоступен — фетч тихо отказывает,
    // витрина уходит в «недоступен»; проверяем, что корзины/заказов нет
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('нет стенда'))),
    );
    const { wrapper } = mountView('live');
    await router.isReady();
    await flush();
    await flush();

    expect(wrapper.text()).not.toContain('Корзина');
    expect(wrapper.text()).not.toContain('Мои заказы');
    vi.unstubAllGlobals();
  });

  it('скидка уровня Зрителя: корзина пересчитана floor, заказ с бейджем 5%', async () => {
    await confirmBigBooking(8); // 0 → Зритель: бар −5%

    const { wrapper, bar } = mountView('demo');
    await router.isReady();
    await flush();
    await flush();

    await wrapper.find('[data-testid="bar-inc-combo-family"]').trigger('click');
    await wrapper.find('[data-testid="bar-inc-combo-family"]').trigger('click');

    // gross 1780, скидка floor(1780 × 5%) = 89 → к оплате 1691
    expect(wrapper.find('[data-testid="bar-cart-total"]').text()).toBe('1780 ₽');
    const discount = wrapper.find('[data-testid="bar-cart-discount"]');
    expect(discount.exists()).toBe(true);
    expect(discount.text()).toContain('−5%');
    expect(discount.text()).toContain('1691 ₽');
    expect(wrapper.find('[data-testid="bar-submit"]').text()).toContain('1691 ₽');

    await wrapper.find('[data-testid="bar-submit"]').trigger('click');
    await flush();
    await flush();

    expect(bar.orders[0].loyaltyDiscountPercent).toBe(5);
    expect(bar.orders[0].totalRub).toBe(1691);
    expect(
      wrapper.find(`[data-testid="bar-order-discount-${bar.orders[0].id}"]`).text(),
    ).toContain('5%');
    bar.stopWatching();
  });
});
