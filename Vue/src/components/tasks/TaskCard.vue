<script setup lang="ts">
import { computed } from 'vue'
import Badge from '@/components/ui/Badge.vue'
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  STATUS_LIST,
  type Task,
  type TaskStatus,
} from '@/types'
import { formatDate, formatRelative, isOverdue } from '@/utils/format'

const props = defineProps<{ task: Task }>()
const emit = defineEmits<{
  edit: []
  remove: []
  'update:status': [status: TaskStatus]
}>()

const statusOptions = STATUS_LIST.map((s) => ({ value: s, label: STATUS_LABELS[s] }))

const overdue = computed(() => isOverdue(props.task.dueDate, props.task.status))
const isDone = computed(() => props.task.status === 'done')

const priorityTone = computed(() => `prio-${props.task.priority}`)
const statusTone = computed(() => {
  switch (props.task.status) {
    case 'todo':
      return 'status-todo'
    case 'in-progress':
      return 'status-progress'
    case 'done':
      return 'status-done'
  }
})

// Двусторонняя привязка статуса через emit — чтобы менять его селектом прямо в карточке.
const statusModel = computed<TaskStatus>({
  get: () => props.task.status,
  set: (value) => emit('update:status', value),
})
</script>

<template>
  <article class="task" :class="{ 'task--done': isDone }">
    <div class="task__main">
      <div class="task__head">
        <h3 class="task__title">{{ task.title }}</h3>
        <div class="task__actions">
          <button class="task__btn" type="button" title="Редактировать" @click="emit('edit')">
            ✎
          </button>
          <button class="task__btn" type="button" title="Удалить" @click="emit('remove')">
            🗑
          </button>
        </div>
      </div>

      <p v-if="task.description" class="task__desc">{{ task.description }}</p>

      <div class="task__badges">
        <Badge :tone="statusTone">{{ STATUS_LABELS[task.status] }}</Badge>
        <Badge :tone="priorityTone">{{ PRIORITY_LABELS[task.priority] }}</Badge>
        <Badge tone="primary">{{ task.category }}</Badge>
        <Badge v-for="tag in task.tags" :key="tag">#{{ tag }}</Badge>
      </div>
    </div>

    <div class="task__foot">
      <label class="task__status">
        <span class="sr-only">Статус</span>
        <select v-model="statusModel" class="task__select">
          <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>

      <div
        class="task__due"
        :class="{ 'task__due--overdue': overdue }"
        :title="formatDate(task.dueDate)"
      >
        <template v-if="task.dueDate">
          ⏰ {{ formatDate(task.dueDate) }} · {{ formatRelative(task.dueDate) }}
        </template>
        <template v-else>Без срока</template>
      </div>
    </div>
  </article>
</template>

<style scoped>
.task {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 1rem 1.1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.15s ease, border-color 0.15s ease, opacity 0.2s ease;
}
.task:hover {
  box-shadow: var(--shadow);
  border-color: var(--border-strong);
}
.task--done {
  opacity: 0.65;
}
.task--done .task__title {
  text-decoration: line-through;
}
.task__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.task__title {
  font-size: 1rem;
  font-weight: 700;
}
.task__actions {
  display: flex;
  gap: 0.15rem;
  flex-shrink: 0;
}
.task__btn {
  background: transparent;
  border: none;
  padding: 0.3rem 0.45rem;
  border-radius: var(--radius-sm);
  font-size: 0.95rem;
  line-height: 1;
}
.task__btn:hover {
  background: var(--surface-2);
}
.task__desc {
  font-size: 0.9rem;
  color: var(--text-muted);
  white-space: pre-wrap;
}
.task__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.task__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.task__select {
  padding: 0.35rem 0.55rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 0.82rem;
  cursor: pointer;
}
.task__select:focus {
  outline: none;
  border-color: var(--primary);
}
.task__due {
  font-size: 0.8rem;
  color: var(--text-muted);
}
.task__due--overdue {
  color: var(--danger);
  font-weight: 600;
}
</style>
