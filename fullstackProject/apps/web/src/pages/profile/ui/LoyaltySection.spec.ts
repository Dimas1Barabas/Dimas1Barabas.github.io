import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/shared/api/app-mode';
import { demoEngine } from '@/shared/api/demo-engine';
import { useLoyaltyStore } from '@/entities/loyalty/model/store';
import LoyaltySection from '@/pages/profile/ui/LoyaltySection.vue';
import { firstFreeSeats, seatPriceOf, firstSession } from '@/shared/api/demo-spec-helpers';

/**
 * Секция «Уровень «Киноман»» профиля: витрина стора — движок в демо
 * считает лестницу (бронь перешагивает порог), вершину и waivers
 * проверяем прямым состоянием стора (движок покрыт demo-loyalty.spec).
 */

function mountSection() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAppStore().mode = 'demo';
  return mount(LoyaltySection, { global: { plugins: [pinia] } });
}

beforeEach(() => {
  vi.useFakeTimers();
  demoEngine.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LoyaltySection (демо-режим)', () => {
  it('Новичок: один перк-кэшбэк, подсказка про Зрителя, полоса 0%', async () => {
    const wrapper = mountSection();
    await nextTick();

    expect(wrapper.find('[data-testid="loyalty-tier"]').text()).toBe('Новичок');
    expect(wrapper.find('[data-testid="loyalty-spent"]').text()).toContain('0 ₽');
    expect(wrapper.text()).toContain('кэшбэк 5% с каждой оплаты');
    // у Новичка один перк: подсказка — не перк, список из одного пункта
    expect(wrapper.findAll('.loyalty-perks li')).toHaveLength(1);
    expect(wrapper.text()).toContain('С уровня «Зритель»');
    expect(wrapper.find('[data-testid="loyalty-progress"]').attributes('style')).toContain('width: 0%');
    // toLocaleString('ru-RU') группирует разряды U+00A0 — ловим \s
    expect(wrapper.find('[data-testid="loyalty-next"]').text()).toMatch(/3\s000\s₽/);
    expect(wrapper.text()).toContain('(0%)');
  });

  it('бронь за порогом: бейдж Зрителя, скидка 5%, прогресс двинулся', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { session } = firstSession();
    const price = seatPriceOf(session.id);
    const seats = firstFreeSeats(demoEngine.seatMap(session.id), 8);
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats,
    });
    demoEngine.pay(booking.id);
    await vi.advanceTimersByTimeAsync(3000);
    spy.mockRestore();
    expect(price * seats.length).toBeGreaterThanOrEqual(3000);

    const wrapper = mountSection();
    await nextTick();

    expect(wrapper.find('[data-testid="loyalty-tier"]').text()).toBe('Зритель');
    expect(wrapper.text()).toContain('кэшбэк 7% с каждой оплаты');
    expect(wrapper.text()).toContain('скидка 5% на заказ кинобара');
    expect(wrapper.find('[data-testid="loyalty-next"]').text()).toContain('«Киноман»');
    const fill = wrapper.find('[data-testid="loyalty-progress"]').attributes('style');
    expect(fill).not.toContain('width: 0%');
  });

  it('Киноман: надбавки спроса гасятся — перк в списке', async () => {
    const wrapper = mountSection();
    await nextTick();

    // refresh на маунте уже отработал (демо-синхронно) — подменяем витрину
    useLoyaltyStore().status = {
      code: 'cinephile',
      name: 'Киноман',
      lifetimeSpentRub: 12345,
      perks: {
        cashbackPercent: 10,
        barDiscountPercent: 10,
        demandMarkupWaived: true,
      },
      next: { name: 'Легенда экрана', toNextRub: 17655, progressPercent: 23 },
    };
    await nextTick();

    expect(wrapper.find('[data-testid="loyalty-tier"]').text()).toBe('Киноман');
    expect(wrapper.text()).toContain('кэшбэк 10% с каждой оплаты');
    expect(wrapper.text()).toContain('скидка 10% на заказ кинобара');
    expect(wrapper.text()).toContain('цена без надбавок за аншлаг');
    expect(wrapper.find('[data-testid="loyalty-progress"]').attributes('style')).toContain('width: 23%');
  });

  it('Легенда: следующей ступени нет — витрина вершины', async () => {
    const wrapper = mountSection();
    await nextTick();

    useLoyaltyStore().status = {
      code: 'legend',
      name: 'Легенда экрана',
      lifetimeSpentRub: 50000,
      perks: {
        cashbackPercent: 15,
        barDiscountPercent: 15,
        demandMarkupWaived: true,
      },
      next: null,
    };
    await nextTick();

    expect(wrapper.find('[data-testid="loyalty-next"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="loyalty-top"]').text()).toContain('Вершина лестницы');
  });
});
