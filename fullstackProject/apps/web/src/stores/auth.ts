import { defineStore } from 'pinia';
import { api, clearAuth, saveAuth, storedToken, storedUser } from '../api/client';
import type { LoginResult, RegisterPayload, User } from '../api/types';

/**
 * Сессия пользователя: токен и профиль живут в localStorage,
 * при каждом запросе client подставляет Authorization: Bearer.
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

    /** успешный login: применяем {accessToken, user} и сохраняем сессию */
    apply(result: LoginResult): void {
      this.token = result.accessToken;
      this.user = result.user;
      saveAuth(result.accessToken, result.user);
    },

    logout(): void {
      this.token = null;
      this.user = null;
      clearAuth();
    },
  },
});
