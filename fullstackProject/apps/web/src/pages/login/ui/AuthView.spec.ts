import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ApiError } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import AuthView from '@/pages/login/ui/AuthView.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div>home</div>' } },
    { path: '/login', component: AuthView },
    { path: '/forgot-password', component: { template: '<div>forgot</div>' } },
  ],
});

function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const appStore = useAppStore();
  appStore.mode = 'live';
  const authStore = useAuthStore();
  const wrapper = mount(AuthView, { global: { plugins: [pinia, router] } });
  return { wrapper, authStore };
}

/** тело 429 Привратника — зеркально RateLimitGuard API и демо-движку */
const rateLimited = (retryAfterSec: number) =>
  new ApiError(
    'HTTP 429',
    429,
    JSON.stringify({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Слишком часто — попробуйте позже',
      code: 'rateLimited',
      retryAfterSec,
    }),
  );

/** заполнить форму входа и отправить */
async function attemptLogin(
  wrapper: ReturnType<typeof mountView>['wrapper'],
): Promise<void> {
  await wrapper.find('input[type="email"]').setValue('brute@cine.local');
  await wrapper.find('input[type="password"]').setValue('wrong-password');
  await wrapper.find('form').trigger('submit');
}

beforeEach(() => {
  localStorage.clear();
});

describe('AuthView: Привратник — брутфорс-лимит входа (429)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('429 замораживает кнопку входа на retryAfterSec и отпускает по отсчёту', async () => {
    const { wrapper, authStore } = mountView();
    authStore.login = vi.fn().mockRejectedValue(rateLimited(12));

    await attemptLogin(wrapper);
    const submit = wrapper.find('button[type="submit"]');

    expect(wrapper.text()).toContain('Слишком много попыток входа');
    expect(wrapper.text()).toContain('подождите 12 с');
    expect(submit.attributes('disabled')).toBeDefined();
    expect(submit.text()).toContain('Подождите 12');

    vi.advanceTimersByTime(6000);
    await nextTick();
    expect(submit.text()).toContain('Подождите 6');

    vi.advanceTimersByTime(6000);
    await nextTick();
    expect(submit.attributes('disabled')).toBeUndefined();
    expect(submit.text()).toContain('Войти');
  });

  it('обычный 401 кулдауна не включает — сообщение из тела ответа', async () => {
    const { wrapper, authStore } = mountView();
    authStore.login = vi.fn().mockRejectedValue(
      new ApiError(
        'HTTP 401',
        401,
        JSON.stringify({ message: 'Неверный email или пароль' }),
      ),
    );

    await attemptLogin(wrapper);
    const submit = wrapper.find('button[type="submit"]');

    expect(wrapper.text()).toContain('Неверный email или пароль');
    expect(submit.text()).not.toContain('Подождите');
    expect(submit.attributes('disabled')).toBeUndefined();
  });
});
