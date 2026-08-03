<script setup lang="ts">
/** Пустое состояние списка. Слот action — для кнопки-призыва к действию. */
interface Props {
  title: string
  subtitle?: string
  icon?: string
}
defineProps<Props>()
</script>

<template>
  <div class="empty">
    <div class="empty__icon">{{ icon ?? '📭' }}</div>
    <h3 class="empty__title">{{ title }}</h3>
    <p v-if="subtitle" class="empty__subtitle">{{ subtitle }}</p>
    <div v-if="$slots.action" class="empty__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.empty {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--text-muted);
}
.empty__icon {
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
}
.empty__title {
  font-size: 1.1rem;
  color: var(--text);
}
.empty__subtitle {
  margin-top: 0.25rem;
  font-size: 0.9rem;
}
.empty__action {
  margin-top: 1rem;
}
</style>
