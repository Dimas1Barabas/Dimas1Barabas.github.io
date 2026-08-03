import { computed, watch } from 'vue'
import { useLocalStorage } from './useLocalStorage'

export type Theme = 'light' | 'dark'

const THEME_KEY = 'taskflow:theme'

/** Определяем предпочтительную тему по системным настройкам. */
function detectInitialTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

// Состояние темы — единое (модуль-синглтон) для всего приложения.
const theme = useLocalStorage<Theme>(THEME_KEY, detectInitialTheme())

/** Вешаем активную тему на <html data-theme="..."> — там её читают CSS-переменные. */
function applyTheme(value: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', value)
  }
}

applyTheme(theme.value)
watch(theme, applyTheme)

/**
 * Композабл темы. Возвращает реактивное состояние и методы переключения.
 * Любой компонент, вызвавший useTheme(), работает с одним и тем же состоянием.
 */
export function useTheme() {
  const isDark = computed(() => theme.value === 'dark')

  function setTheme(value: Theme): void {
    theme.value = value
  }

  function toggle(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  return { theme, isDark, setTheme, toggle }
}
