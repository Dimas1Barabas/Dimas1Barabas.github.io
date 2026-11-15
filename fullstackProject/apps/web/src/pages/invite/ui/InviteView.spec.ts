import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useAppStore } from '@/shared/api/app-mode';
import InviteView from '@/pages/invite/ui/InviteView.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div>home</div>' } },
    { path: '/login', component: { template: '<div>login</div>' } },
    { path: '/invite', component: InviteView },
  ],
});

function mountView(mode: 'demo' | 'live') {
  const pinia = createPinia();
  setActivePinia(pinia);
  const appStore = useAppStore();
  appStore.mode = mode;
  const wrapper = mount(InviteView, { global: { plugins: [pinia, router] } });
  return wrapper;
}

/** navigator.clippery в тестовом окружении только читается — ставим через defineProperty */
function stubClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('InviteView: страница «Пригласить»', () => {
  it('демо: код, размеры бонусов, тоталы и демо-друзья', async () => {
    const wrapper = mountView('demo');
    await router.isReady();

    expect(wrapper.find('[data-testid="referral-code"]').text()).toBe(
      'DEM0C0DE',
    );
    expect(wrapper.text()).toContain('+300');
    expect(wrapper.text()).toContain('+100');
    expect(wrapper.text()).toContain('Мария');
    expect(wrapper.text()).toContain('оплатил ✓');
    expect(wrapper.text()).toContain('ещё не оплатил');
    // тоталы витрины: 2 приглашено / 1 оплатил / +300 заработано
    const earned = wrapper.find('[data-testid="total-earned"]');
    expect(earned.text()).toContain('+300');
    expect(earned.text()).toContain('бонусов заработано');
  });

  it('копирование ссылки: буфер отвечает — кнопка подтверждает', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const wrapper = mountView('demo');
    await router.isReady();

    await wrapper.find('[data-testid="copy-link"]').trigger('click');

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('#/login?ref=DEM0C0DE');
    expect(wrapper.find('[data-testid="copy-link"]').text()).toContain(
      'Скопировано ✓',
    );
  });

  it('буфер недоступен — ссылка показывается для ручного копирования', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const wrapper = mountView('demo');
    await router.isReady();

    await wrapper.find('[data-testid="copy-link"]').trigger('click');

    const hint = wrapper.find('[data-testid="copy-hint"]');
    expect(hint.exists()).toBe(true);
    expect(hint.find('input').element.value).toContain(
      '#/login?ref=DEM0C0DE',
    );
  });

  it('live без сессии — приглашение войти, витрины нет', async () => {
    const wrapper = mountView('live');
    await router.isReady();

    expect(wrapper.text()).toContain('войди');
    expect(wrapper.find('[data-testid="referral-code"]').exists()).toBe(false);
  });
});
