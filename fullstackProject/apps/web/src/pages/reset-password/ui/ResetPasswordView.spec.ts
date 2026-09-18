import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import ResetPasswordView from '@/pages/reset-password/ui/ResetPasswordView.vue';

vi.mock('@/shared/api/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: { ...original.api, resetPassword: vi.fn() },
  };
});

import { api } from '@/shared/api/client';

const user = {
  id: 'u-1',
  email: 'anna@example.com',
  name: 'Анна',
  role: 'user' as const,
  createdAt: '2026-09-06T10:00:00.000Z',
};

const stub = { render: () => null };

async function mountView(query = '') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: stub },
      { path: '/login', component: stub },
      { path: '/forgot-password', component: stub },
    ],
  });
  router.push(`/reset-password${query}`);
  await router.isReady();
  return mount(ResetPasswordView, { global: { plugins: [createPinia(), router] } });
}

describe('ResetPasswordView', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
    useAppStore().mode = 'live';
  });

  it('без токена — предупреждение и ссылка на новый запрос', async () => {
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('токен сброса не найден');
    expect(wrapper.text()).toContain('Запросить новую ссылку');
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('сабмит: resetPassword с токеном из query, пара применяется', async () => {
    vi.mocked(api.resetPassword).mockResolvedValue({
      accessToken: 'jwt-fresh',
      user,
    });
    const wrapper = await mountView('?token=abc-token-123');

    const inputs = wrapper.findAll('input[type="password"]');
    await inputs[0].setValue('new-secret-9');
    await inputs[1].setValue('new-secret-9');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.resetPassword).toHaveBeenCalledWith({
      token: 'abc-token-123',
      newPassword: 'new-secret-9',
    });
    expect(useAuthStore().token).toBe('jwt-fresh');
  });

  it('400 от API — ссылка мертва, предлагаем новую', async () => {
    vi.mocked(api.resetPassword).mockRejectedValue(
      new ApiError('HTTP 400', 400, JSON.stringify({ message: 'Ссылка недействительна или истекла' })),
    );
    const wrapper = await mountView('?token=dead-token-123');

    const inputs = wrapper.findAll('input[type="password"]');
    await inputs[0].setValue('new-secret-9');
    await inputs[1].setValue('new-secret-9');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('недействительна или истекла');
    expect(wrapper.text()).toContain('Запросить новую ссылку');
  });

  it('несовпадение паролей — ошибка без запроса', async () => {
    const wrapper = await mountView('?token=abc-token-123');

    const inputs = wrapper.findAll('input[type="password"]');
    await inputs[0].setValue('new-secret-9');
    await inputs[1].setValue('другой');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(api.resetPassword).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('не совпадают');
  });
});
