import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearAuth, saveAuth } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { Promo, User } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import AdminView from '@/pages/admin/ui/AdminView.vue';

/** Админка: фильм — только live-админ, промокоды — как аналитика (демо открыты) */

vi.mock('@/shared/api/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      adminPromos: vi.fn(),
      createPromo: vi.fn(),
      createMovie: vi.fn(),
    },
  };
});

const adminUser: User = {
  id: 'admin-1',
  email: 'admin@cine.local',
  name: 'Админ',
  role: 'admin',
  createdAt: '2026-09-01T00:00:00Z',
};

const promoFixture = (overrides: Partial<Promo> = {}): Promo => ({
  id: 'p-live',
  code: 'LIVE10',
  kind: 'percent',
  value: 10,
  maxActivations: 50,
  usedCount: 7,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...overrides,
});

/** монтирует страницу; mode ставим ПОСЛЕ mount — как демо-детект по /health */
async function mountAdmin() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(AdminView, { global: { plugins: [pinia] } });
  await flushPromises();
  return wrapper;
}

describe('AdminView', () => {
  beforeEach(() => {
    demoEngine.reset();
    localStorage.clear();
    vi.mocked(api.adminPromos).mockReset();
    vi.mocked(api.createPromo).mockReset();
  });
  afterEach(() => {
    clearAuth();
  });

  it('live без прав: пояснение про админа, промо-секции нет', async () => {
    const wrapper = await mountAdmin();
    useAppStore().mode = 'live';
    await flushPromises();

    expect(wrapper.text()).toContain('Раздел для администратора');
    expect(wrapper.find('.admin-promos').exists()).toBe(false);
    expect(wrapper.find('form.admin-form').exists()).toBe(false);
  });

  it('демо: промо-секция открыта всем — бейдж и сиды в списке', async () => {
    const wrapper = await mountAdmin();
    // режим — в пинию компонента (install делает её активной); watch подхватит
    useAppStore().mode = 'demo';
    await flushPromises();

    expect(wrapper.find('.admin-promos').exists()).toBe(true);
    expect(wrapper.find('.admin-promos__badge').text()).toContain('демо');
    const text = wrapper.find('.admin-promo-list').text();
    expect(text).toContain('CINE10');
    expect(text).toContain('SUMMER300');
    expect(text).toContain('EXPIRED5');
    // фильм в демо всё ещё только для live-админа
    expect(wrapper.text()).toContain('Раздел для администратора');
  });

  it('демо: создание промокода — код нормализован и в списке', async () => {
    const wrapper = await mountAdmin();
    useAppStore().mode = 'demo';
    await flushPromises();

    await wrapper.find('.promo-form input[type="text"]').setValue('sale500');
    await wrapper
      .find('.promo-form select')
      .setValue('fixed');
    const numbers = wrapper.findAll('.promo-form input[type="number"]');
    await numbers[0]!.setValue(500); // размер скидки
    await numbers[1]!.setValue(10); // лимит активаций
    await wrapper.find('.promo-form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('Промокод SALE500 создан');
    expect(wrapper.find('.admin-promo-list').text()).toContain('SALE500');
    expect(wrapper.find('.admin-promo-list').text()).toContain('−500 ₽');
  });

  it('демо: дубль кода — подсказка от ApiError, список цел', async () => {
    const wrapper = await mountAdmin();
    useAppStore().mode = 'demo';
    await flushPromises();

    await wrapper.find('.promo-form input[type="text"]').setValue('cine10');
    await wrapper.find('.promo-form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('уже существует');
    expect(wrapper.find('.admin-promo-list').text()).toContain('CINE10');
  });

  it('live-админ: форма фильма и промо-секция, список из API', async () => {
    // auth-стор читает сессию из localStorage при создании — сеем ДО mount
    saveAuth('test-token', adminUser);
    vi.mocked(api.adminPromos).mockResolvedValue([promoFixture()]);

    const wrapper = await mountAdmin();
    useAppStore().mode = 'live'; // режим — в пинию компонента, после mount
    await flushPromises();

    expect(wrapper.find('.admin-promos').exists()).toBe(true);
    expect(wrapper.find('.admin-promo-list').text()).toContain('LIVE10');
    expect(wrapper.find('.admin-promo-list').text()).toContain('7/50');
    expect(wrapper.find('.admin-promos__badge').exists()).toBe(false);
    // форма фильма доступна: пояснения про «только админ» нет
    expect(wrapper.text()).not.toContain('Раздел для администратора');
    expect(wrapper.findAll('form.admin-form').length).toBe(2);
  });
});
