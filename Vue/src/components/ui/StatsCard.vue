<script setup lang="ts">
/** Карточка-метрика для дашборда. */
interface Props {
  label: string
  value: string | number
  /** Эмодзи/иконка слева. */
  icon?: string
  /** Цвет акцента: primary | success | warning | danger */
  accent?: 'primary' | 'success' | 'warning' | 'danger'
}
withDefaults(defineProps<Props>(), { accent: 'primary' })
</script>

<template>
  <div class="stat" :class="`stat--${accent}`">
    <span v-if="icon" class="stat__icon">{{ icon }}</span>
    <div class="stat__content">
      <div class="stat__value">{{ value }}</div>
      <div class="stat__label">{{ label }}</div>
    </div>
  </div>
</template>

<style scoped>
.stat {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  padding: 1.1rem 1.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 4px solid var(--primary);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
}
.stat__icon {
  font-size: 1.5rem;
  line-height: 1;
}
.stat__value {
  font-size: 1.7rem;
  font-weight: 800;
  line-height: 1.1;
}
.stat__label {
  font-size: 0.85rem;
  color: var(--text-muted);
}

.stat--primary {
  border-left-color: var(--primary);
}
.stat--success {
  border-left-color: var(--success);
}
.stat--warning {
  border-left-color: var(--warning);
}
.stat--danger {
  border-left-color: var(--danger);
}
</style>
