import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { demoEngine } from '@/shared/api/demo-engine';
import type { RecommendationsDto } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useRecommendationsStore } from '@/entities/recommendations/model/store';

/** стор «Вам понравится»: live-запрос за JWT, демо-ветка движка, гость */

vi.mock('@/shared/api/client', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: { recommendations: vi.fn() },
    // localStorage-фейк сессии, как настоящий storedUser
    storedUser: () => {
      const raw = localStorage.getItem('cine.user');
      return raw ? (JSON.parse(raw) as { id: string }) : null;
    },
  };
});

import { api } from '@/shared/api/client';

const recommendationsMock = vi.mocked(api.recommendations);

describe('stores/recommendations', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    demoEngine.reset();
    recommendationsMock.mockReset();
  });

  it('демо: топ движка (сиды дают profile) и живые обновления по onChange', () => {
    useAppStore().mode = 'demo';
    const store = useRecommendationsStore();

    void store.refresh();

    expect(store.basis).toBe('profile');
    expect(store.visible).toBe(true);
    expect(store.items.length).toBeGreaterThan(0);
    // просмотренный сидами «Млечный Путь» не рекомендуется
    expect(store.items.map((i) => i.movieId)).not.toContain('demo-milky-way');
  });

  it('live-гость: блока нет — пустое состояние без запроса', async () => {
    useAppStore().mode = 'live';
    const store = useRecommendationsStore();

    await store.refresh();

    expect(store.loaded).toBe(false);
    expect(store.visible).toBe(false);
    expect(recommendationsMock).not.toHaveBeenCalled();
  });

  it('live-вошедший: спрашивает API и раскладывает ответ', async () => {
    useAppStore().mode = 'live';
    localStorage.setItem('cine.token', 'jwt');
    localStorage.setItem('cine.user', JSON.stringify({ id: 'u1', name: 'А' }));
    const payload: RecommendationsDto = {
      basis: 'profile',
      items: [
        { movieId: 'm2', title: 'Осенний вальс', genre: 'драма', score: 0.6, reason: 'высокий рейтинг зрителей' },
      ],
    };
    recommendationsMock.mockResolvedValue(payload);
    const store = useRecommendationsStore();

    await store.refresh();

    expect(recommendationsMock).toHaveBeenCalledTimes(1);
    expect(store.items).toEqual(payload.items);
    expect(store.visible).toBe(true);
  });

  it('live: сервис недоступен — unavailable, блок скрыт (не ошибка)', async () => {
    useAppStore().mode = 'live';
    localStorage.setItem('cine.token', 'jwt');
    localStorage.setItem('cine.user', JSON.stringify({ id: 'u1', name: 'А' }));
    recommendationsMock.mockRejectedValue(new Error('HTTP 503'));
    const store = useRecommendationsStore();

    await store.refresh();

    expect(store.basis).toBe('unavailable');
    expect(store.visible).toBe(false);
  });
});
