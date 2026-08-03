<script setup lang="ts">
/** Текстовое поле с поддержкой v-model через defineModel. */
interface Props {
  label?: string
  placeholder?: string
  type?: string
  id?: string
  error?: string
  hint?: string
}

withDefaults(defineProps<Props>(), { type: 'text' })

const model = defineModel<string | number>({ default: '' })
</script>

<template>
  <div class="field">
    <label v-if="label" :for="id" class="field__label">{{ label }}</label>
    <input
      :id="id"
      v-model="model"
      :type="type"
      :placeholder="placeholder"
      class="field__input"
      :class="{ 'field__input--error': error }"
    />
    <span v-if="error" class="field__error">{{ error }}</span>
    <span v-else-if="hint" class="field__hint">{{ hint }}</span>
  </div>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field__label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
}

.field__input {
  width: 100%;
  padding: 0.6rem 0.8rem;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  color: var(--text);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.field__input::placeholder {
  color: var(--text-muted);
}

.field__input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.field__input--error {
  border-color: var(--danger);
}
.field__input--error:focus {
  box-shadow: 0 0 0 3px var(--prio-high-soft);
}

.field__error {
  font-size: 0.78rem;
  color: var(--danger);
}
.field__hint {
  font-size: 0.78rem;
  color: var(--text-muted);
}
</style>
