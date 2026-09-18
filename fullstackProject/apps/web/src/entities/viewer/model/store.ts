import { defineStore } from 'pinia';
import { api, clearAuth, saveAuth, storedToken, storedUser } from '@/shared/api/client';
import type { LoginResult, RegisterPayload, User } from '@/shared/api/types';

/**
 * Сессия пользователя: access-токен и профиль живут в localStorage,
 * при каждом запросе client подставляет Authorization: Bearer.
 * Refresh-сессия (30 дней) — в httpOnly-cookie, клиент продлевает её
 * сам при 401; сюда попадают только результаты «свежих» пар.
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: storedToken(),
    user: storedUser(),
  }),
  getters: {
    isAuthed: (state): boolean => !!state.token,
    isAdmin: (state): boolean => state.user?.role === 'admin',
  },
  actions: {
    async login(email: string, password: string): Promise<void> {
      this.apply(await api.login({ email, password }));
    },

    async register(payload: RegisterPayload): Promise<User> {
      return api.register(payload);
    },

    /** успешный login/refresh: применяем {accessToken, user} и сохраняем сессию */
    apply(result: LoginResult): void {
      this.token = result.accessToken;
      this.user = result.user;
      saveAuth(result.accessToken, result.user);
    },

    /** выход: гасим сессию на сервере; локально чистим в любом случае */
    async logout(): Promise<void> {
      try {
        await api.logout();
      } catch {
        // API недоступен/сессия умерла — локальный выход всё равно нужен
      }
      this.token = null;
      this.user = null;
      clearAuth();
    },
  },
});
