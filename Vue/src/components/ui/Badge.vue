<script setup lang="ts">
/**
 * Маленькая метка. tone задаёт цвет и берётся из CSS-переменных:
 * например, tone="prio-high" → цвета --prio-high / --prio-high-soft.
 */
interface Props {
  tone?: string
}
defineProps<Props>()
</script>

<template>
  <span class="badge" :class="tone ? `badge--${tone}` : undefined">
    <slot />
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.4;
  background: var(--surface-2);
  color: var(--text-muted);
  white-space: nowrap;
}

/* тоны: каждый использует пару токенов <name> / <name>-soft */
.badge--prio-low {
  background: var(--prio-low-soft);
  color: var(--prio-low);
}
.badge--prio-medium {
  background: var(--prio-medium-soft);
  color: var(--prio-medium);
}
.badge--prio-high {
  background: var(--prio-high-soft);
  color: var(--prio-high);
}
.badge--status-todo {
  background: var(--status-todo-soft);
  color: var(--status-todo);
}
.badge--status-progress {
  background: var(--status-progress-soft);
  color: var(--status-progress);
}
.badge--status-done {
  background: var(--status-done-soft);
  color: var(--status-done);
}
.badge--danger {
  background: var(--prio-high-soft);
  color: var(--danger);
}
.badge--primary {
  background: var(--primary-soft);
  color: var(--primary);
}
</style>
