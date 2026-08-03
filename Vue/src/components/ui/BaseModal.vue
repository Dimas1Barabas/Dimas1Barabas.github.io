<script setup lang="ts">
/**
 * Модальное окно на <Teleport>.
 * Закрытие по клику на фон, крестик и Escape.
 */
interface Props {
  modelValue: boolean
  title?: string
  width?: string
}

const props = withDefaults(defineProps<Props>(), { width: '520px' })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

function close(): void {
  emit('update:modelValue', false)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="props.modelValue" class="modal-overlay" @click.self="close" @keydown="onKeydown">
        <div class="modal" :style="{ maxWidth: props.width }" role="dialog" aria-modal="true">
          <header v-if="props.title || $slots.header" class="modal__header">
            <slot name="header">
              <h3 class="modal__title">{{ props.title }}</h3>
            </slot>
            <button class="modal__close" type="button" aria-label="Закрыть" @click="close">
              ✕
            </button>
          </header>
          <div class="modal__body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="modal__footer">
            <slot name="footer" :close="close" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
}

.modal {
  width: 100%;
  max-height: 90vh;
  overflow: auto;
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
.modal__title {
  font-size: 1.15rem;
  font-weight: 700;
}
.modal__close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.1rem;
  line-height: 1;
  padding: 0.25rem 0.4rem;
  border-radius: var(--radius-sm);
}
.modal__close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.modal__body {
  padding: 1.25rem;
}
.modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--border);
}

/* Transition */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}
.modal-enter-active .modal,
.modal-leave-active .modal {
  transition: transform 0.18s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal,
.modal-leave-to .modal {
  transform: translateY(12px) scale(0.98);
}
</style>
