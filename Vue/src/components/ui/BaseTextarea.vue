<script setup lang="ts">
/** Многострочное поле. */
interface Props {
  label?: string
  placeholder?: string
  id?: string
  rows?: number
}

withDefaults(defineProps<Props>(), { rows: 3 })

const model = defineModel<string>({ default: '' })
</script>

<template>
  <div class="field">
    <label v-if="label" :for="id" class="field__label">{{ label }}</label>
    <textarea
      :id="id"
      v-model="model"
      :placeholder="placeholder"
      :rows="rows"
      class="field__textarea"
    />
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
}
.field__textarea {
  width: 100%;
  padding: 0.6rem 0.8rem;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  color: var(--text);
  resize: vertical;
  min-height: 4.5rem;
}
.field__textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
</style>
