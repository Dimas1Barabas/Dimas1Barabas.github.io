<script setup lang="ts">
/** Карточка-контейнер. Опционально — заголовок и action-слот. */
interface Props {
  title?: string
  /** Уберёт внутренние отступы (например, для списков). */
  flush?: boolean
}
defineProps<Props>()
</script>

<template>
  <section class="card" :class="{ 'card--flush': flush }">
    <header v-if="title || $slots.actions" class="card__header">
      <h2 v-if="title" class="card__title">{{ title }}</h2>
      <div v-if="$slots.actions" class="card__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="card__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}
.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
.card__title {
  font-size: 1.05rem;
  font-weight: 700;
}
.card__actions {
  display: flex;
  gap: 0.5rem;
}
.card__body {
  padding: 1.25rem;
}
.card--flush .card__body {
  padding: 0;
}
</style>
