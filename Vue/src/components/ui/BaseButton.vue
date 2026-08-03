<script setup lang="ts">
/**
 * Универсальная кнопка.
 * Варианты: primary | secondary | ghost | danger
 * Размеры: sm | md | lg
 */
interface Props {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  /** Растянуть на всю ширину родителя. */
  block?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
  type: 'button',
  disabled: false,
  block: false,
})
</script>

<template>
  <button
    class="btn"
    :class="[`btn--${props.variant}`, `btn--${props.size}`, { 'btn--block': props.block }]"
    :type="props.type"
    :disabled="props.disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  font-weight: 600;
  font-size: 0.92rem;
  line-height: 1;
  white-space: nowrap;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease,
    transform 0.05s ease, opacity 0.15s ease;
}

.btn:active {
  transform: translateY(1px);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* размеры */
.btn--sm {
  padding: 0.4rem 0.7rem;
  font-size: 0.82rem;
}
.btn--md {
  padding: 0.6rem 1rem;
}
.btn--lg {
  padding: 0.8rem 1.4rem;
  font-size: 1rem;
}

/* варианты */
.btn--primary {
  background: var(--primary);
  color: #fff;
}
.btn--primary:hover:not(:disabled) {
  background: var(--primary-hover);
}

.btn--secondary {
  background: var(--surface-2);
  border-color: var(--border);
  color: var(--text);
}
.btn--secondary:hover:not(:disabled) {
  background: var(--surface-hover);
}

.btn--ghost {
  background: transparent;
  color: var(--text-muted);
}
.btn--ghost:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text);
}

.btn--danger {
  background: var(--danger);
  color: #fff;
}
.btn--danger:hover:not(:disabled) {
  opacity: 0.9;
}

.btn--block {
  width: 100%;
}
</style>
