<script setup lang="ts">
/** Селект с опциями { value, label }[]. */
interface Option {
  value: string
  label: string
}

interface Props {
  label?: string
  options: Option[]
  id?: string
}

defineProps<Props>()

const model = defineModel<string>({ default: '' })
</script>

<template>
  <div class="field">
    <label v-if="label" :for="id" class="field__label">{{ label }}</label>
    <select :id="id" v-model="model" class="field__select">
      <option v-for="opt in options" :key="opt.value" :value="opt.value">
        {{ opt.label }}
      </option>
    </select>
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
.field__select {
  width: 100%;
  padding: 0.6rem 0.8rem;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  color: var(--text);
  cursor: pointer;
}
.field__select:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
</style>
