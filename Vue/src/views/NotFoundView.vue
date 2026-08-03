<script setup lang="ts">
import { useRouter } from 'vue-router'
import BaseButton from '@/components/ui/BaseButton.vue'

const router = useRouter()
</script>

<template>
  <div class="not-found">
    <div class="not-found__code">404</div>
    <h1 class="not-found__title">Страница не найдена</h1>
    <p class="not-found__text">
      Похоже, такой задачи в маршрутизаторе нет.
    </p>
    <BaseButton @click="router.push('/')">На главную</BaseButton>
  </div>
</template>

<style scoped>
.not-found {
  text-align: center;
  padding: 5rem 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}
.not-found__code {
  font-size: 5rem;
  font-weight: 900;
  line-height: 1;
  background: linear-gradient(135deg, var(--primary), var(--success));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.not-found__title {
  font-size: 1.4rem;
  font-weight: 700;
  margin-top: 0.5rem;
}
.not-found__text {
  color: var(--text-muted);
  margin-bottom: 1rem;
}
</style>
