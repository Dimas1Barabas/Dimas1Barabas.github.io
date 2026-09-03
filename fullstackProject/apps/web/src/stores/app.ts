import { defineStore } from 'pinia';
import { api } from '../api/client';
import type { HealthResponse } from '../api/types';

export type AppMode = 'loading' | 'live' | 'demo';

export const useAppStore = defineStore('app', {
  state: () => ({
    mode: 'loading' as AppMode,
    health: null as HealthResponse | null,
  }),
  actions: {
    /** Проба бэкенда: недоступен → демо-режим (GitHub Pages) */
    async init(): Promise<void> {
      try {
        this.health = await api.health();
        this.mode = 'live';
      } catch {
        this.mode = 'demo';
      }
    },
  },
});
