import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useAppStore } from '@/shared/api/app-mode';
import { demoEngine } from '@/shared/api/demo-engine';
import GiftsView from '@/pages/gift/ui/GiftsView.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div>home</div>' } },
    { path: '/login', component: { template: '<div>login</div>' } },
    { path: '/gifts', component: GiftsView },
  ],
});

function mountView(mode: 'demo' | 'live') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const appStore = useAppStore();
  appStore.mode = mode;
  const wrapper = mount(GiftsView, { global: { plugins: [pinia, router] } });
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('GiftsView: страница «Подарки»', () => {
  it('демо: сид-карта в таблице, доступно 500 ₽', async () => {
    const wrapper = mountView('demo');
    await router.isReady();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('GIFT-DEM0CA11');
    });

    expect(wrapper.text()).toContain('500');
    expect(wrapper.text()).toContain('доступно картами');
    expect(wrapper.find('[data-testid="gift-card-GIFT-DEM0CA11"]').exists()).toBe(
      true,
    );
  });

  it('покупка: код появляется крупно и в подаренных', async () => {
    const wrapper = mountView('demo');
    await router.isReady();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('GIFT-DEM0CA11');
    });

    await wrapper.find('[data-testid="gift-nominal-1000"]').trigger('click');
    await wrapper.find('[data-testid="gift-buy"]').trigger('click');

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="gift-fresh"]').exists()).toBe(true);
    });
    const code = wrapper.find('[data-testid="gift-fresh-code"]').text();
    expect(code).toMatch(/^GIFT-[0-9A-HJKMNP-TV-Z]{8}$/);
    // куплена, но не активирована — лежит в «подаренных»
    expect(wrapper.text()).toContain('ждёт получателя');
    // и доступный остаток не изменился: карта ещё не активна
    expect(wrapper.text()).toContain('доступно картами');
  });

  it('активация своего кода: карта оживает, ошибка при повторе', async () => {
    // покупаем и активируем карту напрямую движком — как получатель кода
    const bought = demoEngine.buyGift(2000);
    const wrapper = mountView('demo');
    await router.isReady();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('GIFT-DEM0CA11');
    });

    const input = wrapper.find('[data-testid="gift-activate-input"]');
    await input.setValue(bought.code.toLowerCase());
    await wrapper.find('form').trigger('submit');

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="gift-activated-ok"]').exists()).toBe(
        true,
      );
    });
    expect(wrapper.find('[data-testid="gift-activated-ok"]').text()).toContain(
      bought.code,
    );

    // повторная активация — честный 409 от движка, подсказка на экране
    await input.setValue(bought.code);
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="gift-activate-error"]').exists()).toBe(
        true,
      );
    });
    expect(wrapper.find('[data-testid="gift-activate-error"]').text()).toContain(
      'уже активирован',
    );
  });

  it('опечатка в подаренном коде — подсказка 404, как от API', async () => {
    const wrapper = mountView('demo');
    await router.isReady();
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('GIFT-DEM0CA11');
    });

    const input = wrapper.find('[data-testid="gift-activate-input"]');
    await input.setValue('GIFT-NOPE1234');
    await wrapper.find('form').trigger('submit');

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="gift-activate-error"]').exists()).toBe(
        true,
      );
    });
    expect(wrapper.find('[data-testid="gift-activate-error"]').text()).toContain(
      'не найден',
    );
  });

  it('live без сессии — приглашение войти, витрины нет', async () => {
    const wrapper = mountView('live');
    await router.isReady();

    expect(wrapper.text()).toContain('войди');
    expect(wrapper.find('[data-testid="gift-buy"]').exists()).toBe(false);
  });
});
