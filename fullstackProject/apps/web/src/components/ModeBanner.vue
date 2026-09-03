<script setup lang="ts">
import { useAppStore } from '../stores/app';

const appStore = useAppStore();
</script>

<template>
  <div v-if="appStore.mode === 'demo'" class="container">
    <div class="mode-banner">
      <span class="mode-banner__icon">🧪</span>
      <span>
        Бэкенд не поднят — интерфейс работает в
        <strong>демо-режиме</strong>: бронирования обрабатывает локальная
        симуляция Go-воркера (те же тайминги и вероятности).
        <RouterLink to="/architecture">Как поднять полный стек →</RouterLink>
      </span>
    </div>
  </div>
</template>
