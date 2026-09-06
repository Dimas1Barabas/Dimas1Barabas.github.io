<script setup lang="ts">
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';

const appStore = useAppStore();
const authStore = useAuthStore();
</script>

<template>
  <header class="site-header">
    <div class="container header-inner">
      <RouterLink to="/" class="brand">
        <span class="brand-icon">🎟️</span>
        <span>CineBooking</span>
      </RouterLink>

      <nav class="nav">
        <RouterLink to="/">Сеансы</RouterLink>
        <RouterLink to="/bookings">Бронирования</RouterLink>
        <RouterLink to="/architecture">Архитектура</RouterLink>
        <RouterLink v-if="authStore.isAdmin" to="/admin">Новый сеанс</RouterLink>
      </nav>

      <span
        v-if="appStore.mode === 'live'"
        class="mode-pill mode-pill--live"
        title="Бэкенд доступен: полная схема с Postgres, Redis и RabbitMQ"
      >
        ● live API
      </span>
      <span
        v-else-if="appStore.mode === 'demo'"
        class="mode-pill mode-pill--demo"
        title="Бэкенд не отвечает — работает локальная симуляция"
      >
        ● демо-режим
      </span>

      <!-- сессия: только при живом API (в демо авторизации нет) -->
      <div v-if="appStore.mode === 'live'" class="header-auth">
        <template v-if="authStore.isAuthed">
          <RouterLink to="/admin" class="user-chip" :title="authStore.user?.email">
            <span class="user-chip__name">{{ authStore.user?.name }}</span>
            <span v-if="authStore.isAdmin" class="user-chip__role">admin</span>
          </RouterLink>
          <button class="btn btn--ghost btn--compact" type="button" @click="authStore.logout()">
            Выйти
          </button>
        </template>
        <RouterLink v-else class="btn btn--ghost btn--compact" to="/login">
          Войти
        </RouterLink>
      </div>
    </div>
  </header>
</template>

<style scoped>
.header-auth {
  display: flex;
  align-items: center;
  gap: 8px;
}

.user-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  text-decoration: none;
  max-width: 180px;
}

.user-chip__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-chip__role {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #ffd166;
}

.btn--compact {
  padding: 6px 12px;
  font-size: 0.85rem;
}
</style>
