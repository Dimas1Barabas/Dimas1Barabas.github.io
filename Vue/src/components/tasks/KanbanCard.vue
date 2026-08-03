<script setup lang="ts">
import { computed } from 'vue'
import Badge from '@/components/ui/Badge.vue'
import { PRIORITY_LABELS, type Task } from '@/types'
import { formatDate, isOverdue } from '@/utils/format'

const props = defineProps<{ task: Task }>()
const emit = defineEmits<{
  edit: []
  remove: []
  /** Начат drag — передаём id наверх, чтобы доска знала, что перетаскивается. */
  dragstart: [id: string]
}>()

const overdue = computed(() => isOverdue(props.task.dueDate, props.task.status))
const isDone = computed(() => props.task.status === 'done')
const priorityTone = computed(() => `prio-${props.task.priority}`)
</script>

<template>
  <div
    class="kanban-card"
    :class="{ 'kanban-card--done': isDone }"
    draggable="true"
    @dragstart="emit('dragstart', task.id)"
  >
    <div class="kanban-card__head">
      <span class="kanban-card__title">{{ task.title }}</span>
      <div class="kanban-card__actions">
        <button type="button" class="kanban-card__btn" title="Редактировать" @click="emit('edit')">
          ✎
        </button>
        <button type="button" class="kanban-card__btn" title="Удалить" @click="emit('remove')">
          🗑
        </button>
      </div>
    </div>

    <div class="kanban-card__badges">
      <Badge :tone="priorityTone">{{ PRIORITY_LABELS[task.priority] }}</Badge>
      <Badge v-if="task.category" tone="primary">{{ task.category }}</Badge>
    </div>

    <div v-if="task.dueDate" class="kanban-card__due" :class="{ 'kanban-card__due--overdue': overdue }">
      ⏰ {{ formatDate(task.dueDate) }}
    </div>
  </div>
</template>

<style scoped>
.kanban-card {
  padding: 0.7rem 0.8rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-sm);
  cursor: grab;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  transition: box-shadow 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}
.kanban-card:hover {
  box-shadow: var(--shadow);
  border-color: var(--border-strong);
}
.kanban-card:active {
  cursor: grabbing;
  transform: rotate(1.5deg);
}
.kanban-card--done {
  opacity: 0.6;
}
.kanban-card--done .kanban-card__title {
  text-decoration: line-through;
}
.kanban-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}
.kanban-card__title {
  font-weight: 600;
  font-size: 0.92rem;
}
.kanban-card__actions {
  display: flex;
  gap: 0.1rem;
  flex-shrink: 0;
}
.kanban-card__btn {
  background: transparent;
  border: none;
  padding: 0.2rem 0.4rem;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
}
.kanban-card__btn:hover {
  background: var(--surface-2);
}
.kanban-card__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.kanban-card__due {
  font-size: 0.78rem;
  color: var(--text-muted);
}
.kanban-card__due--overdue {
  color: var(--danger);
  font-weight: 600;
}
</style>
