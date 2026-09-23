import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import MyBookingsView from '@/pages/my-bookings/ui/MyBookingsView.vue';

vi.mock('@/shared/api/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      myBookings: vi.fn(),
      myBonuses: vi.fn(),
      myWaitlist: vi.fn(),
    },
  };
});

import { api } from '@/shared/api/client';

/** SSE-стрим в тестах не нужен — вместо EventSource пустышка */
class FakeEventSource {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

const user = {
  id: 'u-1',
  email: 'anna@example.com',
  name: 'Анна',
  role: 'user' as const,
  createdAt: '2026-09-06T10:00:00.000Z',
};

const stub = { render: () => null };

/** live-режим + вошедший пользователь (без localStorage — SSE молчит).
 *  Сторы сидим ДО mount: onMounted компонента читает mode сразу.
 *  Сессию кладём и в localStorage: стор бонусов смотрит storedUser() */
async function mountAuthed() {
  localStorage.setItem('cine.token', 'jwt-1');
  localStorage.setItem('cine.user', JSON.stringify(user));

  const pinia: Pinia = createPinia();
  setActivePinia(pinia);
  useAppStore().mode = 'live';
  const authStore = useAuthStore();
  authStore.token = 'jwt-1';
  authStore.user = user;

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: stub },
      { path: '/login', component: stub },
    ],
  });
  const wrapper = mount(MyBookingsView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('MyBookingsView: бонусный счёт', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(api.myBookings).mockResolvedValue([]);
    vi.mocked(api.myWaitlist).mockResolvedValue([]);
  });

  it('карточка счёта: баланс и история с подписями причин', async () => {
    vi.mocked(api.myBonuses).mockResolvedValue({
      balance: 260,
      transactions: [
        {
          id: 't-1',
          kind: 'accrual',
          reason: 'cashback',
          amount: 50,
          bookingId: 'b-1',
          createdAt: '2026-09-22T10:00:00.000Z',
        },
        {
          id: 't-2',
          kind: 'spend',
          reason: 'payment',
          amount: 90,
          bookingId: 'b-2',
          createdAt: '2026-09-20T10:00:00.000Z',
        },
      ],
    });

    const wrapper = await mountAuthed();

    const card = wrapper.find('.bonus-card');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain('Бонусный счёт');
    expect(card.text()).toContain('260');
    expect(card.text()).toContain('кэшбэк за бронь');
    expect(card.text()).toContain('+50');
    expect(card.text()).toContain('оплата бонусами');
    expect(card.text()).toContain('−90');
  });

  it('без истории — карточка с балансом и без строк', async () => {
    vi.mocked(api.myBonuses).mockResolvedValue({
      balance: 0,
      transactions: [],
    });

    const wrapper = await mountAuthed();

    expect(wrapper.find('.bonus-card').exists()).toBe(true);
    expect(wrapper.find('.bonus-card__list').exists()).toBe(false);
  });
});
