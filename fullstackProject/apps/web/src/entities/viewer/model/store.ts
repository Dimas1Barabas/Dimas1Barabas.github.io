import { defineStore } from 'pinia';
import {
  api,
  clearAuth,
  saveAuth,
  storedToken,
  storedUser,
} from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import type {
  ChangePasswordPayload,
  LoginResult,
  RegisterPayload,
  UpdateProfilePayload,
  User,
} from '@/shared/api/types';

/**
 * Сессия пользователя. Live: access в localStorage + refresh в httpOnly-cookie
 * (client сам продлевает при 401). Демо: симуляция движком — сессия только
 * в памяти, перезагрузка = выход, localStorage не трогаем.
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
    demoMode(): boolean {
      return useAppStore().mode === 'demo';
    },

    async login(email: string, password: string): Promise<void> {
      const demo = this.demoMode();
      this.apply(
        demo ? demoEngine.login(email, password) : await api.login({ email, password }),
        { persist: !demo },
      );
    },

    async register(payload: RegisterPayload): Promise<User> {
      return this.demoMode() ? demoEngine.register(payload) : api.register(payload);
    },

    /** свежая пара (login/refresh/профиль): в live — с персистом, в демо — только state */
    apply(result: LoginResult, options: { persist?: boolean } = {}): void {
      this.token = result.accessToken;
      this.user = result.user;
      if (options.persist !== false) {
        saveAuth(result.accessToken, result.user);
      }
    },

    /** выход: гасим сессию на сервере/в движке; локально чистим в любом случае */
    async logout(): Promise<void> {
      if (this.demoMode()) {
        demoEngine.logout();
      } else {
        try {
          await api.logout();
        } catch {
          // API недоступен/сессия умерла — локальный выход всё равно нужен
        }
      }
      this.token = null;
      this.user = null;
      clearAuth();
    },

    /** профиль: имя/email; ответ — свежая пара (клеймы живут в JWT live) */
    async updateProfile(payload: UpdateProfilePayload): Promise<void> {
      const demo = this.demoMode();
      this.apply(
        demo ? demoEngine.updateProfile(payload) : await api.updateProfile(payload),
        { persist: !demo },
      );
    },

    /** смена пароля: ревокает все сессии, это устройство получает новую пару */
    async changePassword(payload: ChangePasswordPayload): Promise<void> {
      const demo = this.demoMode();
      this.apply(
        demo
          ? demoEngine.changePassword(payload.currentPassword, payload.newPassword)
          : await api.changePassword(payload),
        { persist: !demo },
      );
    },

    /** запрос письма сброса; в демо возвращает токен — ссылку рисует страница */
    async forgotPassword(email: string): Promise<string | null> {
      if (this.demoMode()) return demoEngine.forgotPassword(email);
      await api.forgotPassword(email);
      return null;
    },

    /** сброс по одноразовой ссылке: это устройство сразу залогинено */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      const demo = this.demoMode();
      this.apply(
        demo
          ? demoEngine.resetPassword(token, newPassword)
          : await api.resetPassword({ token, newPassword }),
        { persist: !demo },
      );
    },
  },
});
