<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTaskStore } from '@/stores/tasks'
import KanbanCard from '@/components/tasks/KanbanCard.vue'
import TaskForm from '@/components/tasks/TaskForm.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { STATUS_LABELS, STATUS_LIST, type Task, type TaskInput, type TaskStatus } from '@/types'

const store = useTaskStore()
const { tasks, tasksByStatus } = storeToRefs(store)

// --- drag & drop ---
const draggingId = ref<string | null>(null)
const dragOverStatus = ref<TaskStatus | null>(null)

const columns = STATUS_LIST.map((status) => ({
  status,
  label: STATUS_LABELS[status],
  icon: status === 'todo' ? '📥' : status === 'in-progress' ? '⏳' : '✅',
}))

function onDragStart(id: string): void {
  draggingId.value = id
}

function onDragEnter(status: TaskStatus): void {
  dragOverStatus.value = status
}

function onDrop(status: TaskStatus): void {
  if (draggingId.value) {
    store.setStatus(draggingId.value, status)
  }
  draggingId.value = null
  dragOverStatus.value = null
}

function onDragEnd(): void {
  draggingId.value = null
  dragOverStatus.value = null
}

// --- модалка создания/редактирования ---
const isModalOpen = ref(false)
const editingTask = ref<Task | null>(null)

function openCreate(): void {
  editingTask.value = null
  isModalOpen.value = true
}
function openEdit(task: Task): void {
  editingTask.value = task
  isModalOpen.value = true
}
function closeModal(): void {
  isModalOpen.value = false
  editingTask.value = null
}
function handleSubmit(input: TaskInput): void {
  if (editingTask.value) store.updateTask(editingTask.value.id, input)
  else store.addTask(input)
  closeModal()
}
function handleRemove(task: Task): void {
  if (window.confirm(`Удалить задачу «${task.title}»?`)) store.removeTask(task.id)
}
</script>

<template>
  <div class="board-view">
    <header class="page-header">
      <div>
        <h1 class="page-title">Доска</h1>
        <p class="page-subtitle">Перетаскивайте карточки между колонками</p>
      </div>
      <BaseButton @click="openCreate">＋ Добавить задачу</BaseButton>
    </header>

    <div v-if="tasks.length" class="board" @dragend="onDragEnd">
      <section
        v-for="col in columns"
        :key="col.status"
        class="column"
        :class="{ 'column--over': dragOverStatus === col.status }"
        @dragover.prevent
        @dragenter.prevent="onDragEnter(col.status)"
        @drop.prevent="onDrop(col.status)"
      >
        <header class="column__head">
          <span class="column__title">{{ col.icon }} {{ col.label }}</span>
          <span class="column__count">{{ tasksByStatus[col.status].length }}</span>
        </header>

        <TransitionGroup name="card" tag="div" class="column__body">
          <KanbanCard
            v-for="task in tasksByStatus[col.status]"
            :key="task.id"
            :task="task"
            @edit="openEdit(task)"
            @remove="handleRemove(task)"
            @dragstart="onDragStart"
          />
        </TransitionGroup>

        <p v-if="!tasksByStatus[col.status].length" class="column__empty">Перетащите задачу сюда</p>
      </section>
    </div>

    <EmptyState
      v-else
      icon="🗂️"
      title="Доска пуста"
      subtitle="Создайте задачи, чтобы разложить их по колонкам"
    >
      <template #action>
        <BaseButton @click="openCreate">＋ Добавить задачу</BaseButton>
      </template>
    </EmptyState>

    <BaseModal v-model="isModalOpen" :title="editingTask ? 'Редактирование задачи' : 'Новая задача'">
      <TaskForm :task="editingTask" @submit="handleSubmit" @cancel="closeModal" />
    </BaseModal>
  </div>
</template>

<style scoped>
.board-view {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.page-title {
  font-size: 1.6rem;
  font-weight: 800;
}
.page-subtitle {
  color: var(--text-muted);
  font-size: 0.9rem;
  margin-top: 0.15rem;
}

.board {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  align-items: start;
}

.column {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 0.75rem;
  min-height: 200px;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.column--over {
  background: var(--primary-soft);
  border-color: var(--primary);
}
.column__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
  padding: 0 0.25rem;
}
.column__title {
  font-weight: 700;
  font-size: 0.95rem;
}
.column__count {
  display: grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  padding: 0 0.4rem;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--text-muted);
}
.column__body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.column__empty {
  text-align: center;
  padding: 1.5rem 0.5rem;
  border: 2px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
  font-size: 0.85rem;
}

/* TransitionGroup для карточек внутри колонки */
.card-enter-active,
.card-leave-active {
  transition: all 0.2s ease;
}
.card-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.card-leave-to {
  opacity: 0;
}
.card-leave-active {
  position: absolute;
  width: calc(100% - 1.5rem);
}
.card-move {
  transition: transform 0.2s ease;
}

@media (max-width: 820px) {
  .board {
    grid-template-columns: 1fr;
  }
}
</style>
