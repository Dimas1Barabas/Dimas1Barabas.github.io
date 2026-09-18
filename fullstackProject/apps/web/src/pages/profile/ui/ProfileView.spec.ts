import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import ProfileView from '@/pages/profile/ui/ProfileView.vue';

vi.mock('@/shared/api/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      updateProfile: vi.fn(),
      changePassword: vi.fn(),
    },
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

/** mount + сидинг сторов В pinia компонента (install делает её активной) */
async function mountAuthed() {
  const pinia: Pinia = createPinia();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: stub },
      { path: '/login', component: stub },
    ],
  });
  const wrapper = mount(ProfileView, { global: { plugins: [pinia, router] } });

  const appStore = useAppStore();
  appStore.mode = 'live';
  const authStore = useAuthStore();
  authStore.token = 'jwt-1';
  authStore.user = user;
  await flushPromises();
  return wrapper;
}

describe('ProfileView', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('рендерит обе формы при живом API и вошедшем', async () => {
    const wrapper = await mountAuthed();

    expect(wrapper.text()).toContain('Аккаунт');
    expect(wrapper.text()).toContain('Смена пароля');
    expect(wrapper.find('input[type="email"]').element).toBeTruthy();
  });

  it('сохранение профиля: apply свежей пары и подтверждение', async () => {
    vi.mocked(api.updateProfile).mockResolvedValue({
      accessToken: 'jwt-2',
      user: { ...user, name: 'Анна Новая' },
    });
    const wrapper = await mountAuthed();

    await wrapper.find('input[type="email"]').setValue('anna@example.com');
    await wrapper.find('input[autocomplete="name"]').setValue('Анна Новая');
    await wrapper.findAll('form')[0].trigger('submit');
    await flushPromises();

    expect(api.updateProfile).toHaveBeenCalledWith({ name: 'Анна Новая' });
    expect(useAuthStore().user?.name).toBe('Анна Новая');
    expect(wrapper.text()).toContain('Сохранено');
  });

  it('несовпадение новых паролей — ошибка без запроса', async () => {
    const wrapper = await mountAuthed();

    const passwordInputs = wrapper.findAll('input[type="password"]');
    await passwordInputs[0].setValue('old-secret');
    await passwordInputs[1].setValue('new-secret-9');
    await passwordInputs[2].setValue('другой');
    await wrapper.findAll('form')[1].trigger('submit');
    await flushPromises();

    expect(api.changePassword).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('не совпадают');
  });

  it('403 с телом от API — показываем message («Неверный текущий пароль»)', async () => {
    vi.mocked(api.changePassword).mockRejectedValue(
      new ApiError('HTTP 403', 403, JSON.stringify({ message: 'Неверный текущий пароль' })),
    );
    const wrapper = await mountAuthed();

    const passwordInputs = wrapper.findAll('input[type="password"]');
    await passwordInputs[0].setValue('wrong-old');
    await passwordInputs[1].setValue('new-secret-9');
    await passwordInputs[2].setValue('new-secret-9');
    await wrapper.findAll('form')[1].trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('Неверный текущий пароль');
  });
});
