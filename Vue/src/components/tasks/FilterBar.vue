<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useTaskStore } from '@/stores/tasks'
import {
  PRIORITY_LABELS,
  PRIORITY_LIST,
  STATUS_LABELS,
  STATUS_LIST,
  type SortKey,
} from '@/types'

const store = useTaskStore()
// Реактивные поля стора разворачиваем через storeToRefs, чтобы не потерять реактивность.
const { filters, categories, sortKey, sortDir } = storeToRefs(store)

const statusOptions = [
  { value: 'all', label: 'Все статусы' },
  ...STATUS_LIST.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
]
const priorityOptions = [
  { value: 'all', label: 'Любой приоритет' },
  ...PRIORITY_LIST.map((p) => ({ value: p, label: PRIORITY_LABELS[p] })),
]
const categoryOptions = computed(() =>
  categories.value.map((c) => ({ value: c, label: c === 'all' ? 'Все категории' : c })),
)

const sortOptions: { value: SortKey; label: string }[] = [
  { value: 'createdAt', label: 'По дате создания' },
  { value: 'dueDate', label: 'По сроку' },
  { value: 'priority', label: 'По приоритету' },
  { value: 'title', label: 'По названию' },
]
</script>

<template>
  <div class="filters">
    <div class="filters__search">
      <span class="filters__icon">🔍</span>
      <input
        v-model="filters.search"
        type="search"
        placeholder="Поиск по названию, описанию, тегам…"
        class="filters__input"
      />
    </div>

    <div class="filters__row">
      <select v-model="filters.status" class="filters__select">
        <option v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>

      <select v-model="filters.priority" class="filters__select">
        <option v-for="o in priorityOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>

      <select v-model="filters.category" class="filters__select">
        <option v-for="o in categoryOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>

      <select v-model="sortKey" class="filters__select">
        <option v-for="o in sortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>

      <button
        class="filters__dir"
        type="button"
        :title="sortDir === 'asc' ? 'По возрастанию' : 'По убыванию'"
        @click="sortDir = sortDir === 'asc' ? 'desc' : 'asc'"
      >
        {{ sortDir === 'asc' ? '↑' : '↓' }}
      </button>

      <button class="filters__reset" type="button" @click="store.resetFilters()">
        Сбросить
      </button>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.9rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.filters__search {
  position: relative;
}
.filters__icon {
  position: absolute;
  left: 0.7rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.9rem;
}
.filters__input {
  width: 100%;
  padding: 0.6rem 0.8rem 0.6rem 2.1rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
}
.filters__input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}
.filters__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.filters__select {
  flex: 1 1 140px;
  padding: 0.5rem 0.6rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  cursor: pointer;
}
.filters__select:focus {
  outline: none;
  border-color: var(--primary);
}
.filters__dir {
  padding: 0.5rem 0.7rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 1rem;
  font-weight: 700;
}
.filters__dir:hover {
  background: var(--surface-hover);
}
.filters__reset {
  padding: 0.5rem 0.8rem;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
  font-size: 0.85rem;
}
.filters__reset:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
</style>
