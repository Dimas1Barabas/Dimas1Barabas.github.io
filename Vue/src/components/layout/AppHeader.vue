<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { useTheme } from '@/composables/useTheme'

const route = useRoute()
const { isDark, toggle } = useTheme()

const links = [
  { to: '/', label: 'Обзор' },
  { to: '/tasks', label: 'Задачи' },
  { to: '/board', label: 'Доска' },
  { to: '/about', label: 'О проекте' },
] as const

/** Активна ли ссылка: для корня — точное совпадение, иначе — по префиксу. */
function isActive(to: string): boolean {
  return to === '/' ? route.path === '/' : route.path.startsWith(to)
}
</script>

<template>
  <header class="header">
    <div class="container header__inner">
      <RouterLink to="/" class="brand">
        <span class="brand__logo">✓</span>
        <span class="brand__name">TaskFlow</span>
      </RouterLink>

      <nav class="nav">
        <RouterLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="nav__link"
          :class="{ 'nav__link--active': isActive(link.to) }"
        >
          {{ link.label }}
        </RouterLink>
      </nav>

      <button
        class="theme-toggle"
        type="button"
        :title="isDark ? 'Включить светлую тему' : 'Включить тёмную тему'"
        @click="toggle"
      >
        {{ isDark ? '☀️' : '🌙' }}
      </button>
    </div>
  </header>
</template>

<style scoped>
.header {
  position: sticky;
  top: 0;
  z-index: 50;
  height: var(--header-h);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.header__inner {
  display: flex;
  align-items: center;
  gap: 1rem;
  height: 100%;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 800;
  font-size: 1.15rem;
}
.brand__logo {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  font-size: 0.9rem;
}
.nav {
  display: flex;
  gap: 0.25rem;
  margin-left: auto;
}
.nav__link {
  padding: 0.45rem 0.8rem;
  border-radius: var(--radius);
  color: var(--text-muted);
  font-weight: 600;
  font-size: 0.92rem;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.nav__link:hover {
  background: var(--surface-2);
  color: var(--text);
}
.nav__link--active {
  background: var(--primary-soft);
  color: var(--primary);
}
.theme-toggle {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: 38px;
  height: 38px;
  font-size: 1rem;
  display: grid;
  place-items: center;
}
.theme-toggle:hover {
  background: var(--surface-hover);
}

@media (max-width: 560px) {
  .nav__link {
    padding: 0.4rem 0.55rem;
    font-size: 0.85rem;
  }
  .brand__name {
    display: none;
  }
}
</style>
