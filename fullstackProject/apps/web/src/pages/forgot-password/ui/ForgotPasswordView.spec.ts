import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/shared/api/app-mode';
import { demoEngine } from '@/shared/api/demo-engine';
import ForgotPasswordView from '@/pages/forgot-password/ui/ForgotPasswordView.vue';

vi.mock('@/shared/api/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: { ...original.api, forgotPassword: vi.fn() },
  };
});

import { api } from '@/shared/api/client';

const stub = { render: () => null };

async function mountView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: stub },
      { path: '/login', component: stub },
    ],
  });
  return mount(ForgotPasswordView, { global: { plugins: [createPinia(), router] } });
}

describe('ForgotPasswordView', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
    demoEngine.reset();
    useAppStore().mode = 'live';
  });

  it('сабмит шлёт email и показывает экран «отправлено»', async () => {
    vi.mocked(api.forgotPassword).mockResolvedValue(undefined);
    const wrapper = await mountView();

    await wrapper.find('input[type="email"]').setValue('anna@example.com');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.forgotPassword).toHaveBeenCalledWith('anna@example.com');
    expect(wrapper.text()).toContain('письмо со ссылкой');
  });

  it('даже ошибка API не меняет экран — не оракул', async () => {
    vi.mocked(api.forgotPassword).mockRejectedValue(new Error('сеть'));
    const wrapper = await mountView();

    await wrapper.find('input[type="email"]').setValue('ghost@example.com');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('письмо со ссылкой');
  });

  it('в демо «письмо» печатается на экране — ссылка сброса кликабельна', async () => {
    const wrapper = await mountView();
    // режим — в pinia компонента (install делает её активной)
    useAppStore().mode = 'demo';

    await wrapper.find('input[type="email"]').setValue('anna@example.com');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('открыть ссылку сброса');
    // memory-history в спеке не даёт hash-href — сверяем адрес ссылки по содержимому
    const hrefs = wrapper.findAll('a').map((a) => a.attributes('href') ?? '');
    expect(hrefs.some((h) => h.includes('reset-password?token=demo-reset-token'))).toBe(
      true,
    );
  });
});
