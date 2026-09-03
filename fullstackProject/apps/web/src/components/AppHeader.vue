<script setup lang="ts">
import { useAppStore } from '../stores/app';

const appStore = useAppStore();
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
    </div>
  </header>
</template>
