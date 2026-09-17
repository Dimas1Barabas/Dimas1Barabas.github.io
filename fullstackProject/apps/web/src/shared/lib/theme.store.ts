import { defineStore } from 'pinia';

export type Theme = 'dark' | 'light';

/** тот же ключ читает инлайн-скрипт в index.html — до отрисовки, против FOUC */
const STORAGE_KEY = 'cine.theme';

function readStored(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    /* приватный режим браузера — остаёмся на тёмной */
    return null;
  }
}

function persist(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* не сумели записать — тема всё равно применится на эту сессию */
  }
}

/** CSS смотрит на атрибут: [data-theme='light'] перекрывает токены */
function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export const useThemeStore = defineStore('theme', {
  state: () => ({
    theme: 'dark' as Theme,
  }),
  getters: {
    isLight: (state) => state.theme === 'light',
  },
  actions: {
    /** синхронизируем стор с тем, что инлайн-скрипт уже применил при загрузке */
    init(): void {
      this.theme = readStored() ?? 'dark';
      apply(this.theme);
    },
    toggle(): void {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      apply(this.theme);
      persist(this.theme);
    },
  },
});
