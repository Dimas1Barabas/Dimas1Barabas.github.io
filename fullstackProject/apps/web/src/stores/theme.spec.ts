import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useThemeStore } from './theme';

describe('theme store: светлая тема', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('по умолчанию тёмная и применяет её на <html>', () => {
    const store = useThemeStore();

    store.init();

    expect(store.theme).toBe('dark');
    expect(store.isLight).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('toggle переключает тему, применяет и сохраняет выбор', () => {
    const store = useThemeStore();
    store.init();

    store.toggle();

    expect(store.theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('cine.theme')).toBe('light');

    store.toggle();

    expect(store.theme).toBe('dark');
    expect(localStorage.getItem('cine.theme')).toBe('dark');
  });

  it('init подхватывает сохранённую светлую тему', () => {
    localStorage.setItem('cine.theme', 'light');
    const store = useThemeStore();

    store.init();

    expect(store.isLight).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('мусор в localStorage не ломает init — остаёмся на тёмной', () => {
    localStorage.setItem('cine.theme', 'neon-синий');
    const store = useThemeStore();

    store.init();

    expect(store.theme).toBe('dark');
  });
});
