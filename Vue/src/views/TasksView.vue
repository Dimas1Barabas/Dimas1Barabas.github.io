<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTaskStore } from '@/stores/tasks'
import TaskCard from '@/components/tasks/TaskCard.vue'
import TaskForm from '@/components/tasks/TaskForm.vue'
import FilterBar from '@/components/tasks/FilterBar.vue'
import BaseModal from '@/components/ui/BaseModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import type { Task, TaskInput, TaskStatus } from '@/types'

const store = useTaskStore()
const { tasks, filteredTasks } = storeToRefs(store)

const isModalOpen = ref(false)
/** null — создаём новую, иначе редактируем эту задачу. */
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
  if (editingTask.value) {
    store.updateTask(editingTask.value.id, input)
  } else {
    store.addTask(input)
  }
  closeModal()
}

function handleRemove(task: Task): void {
  if (window.confirm(`Удалить задачу «${task.title}»?`)) {
    store.removeTask(task.id)
  }
}

function handleStatusChange(task: Task, status: TaskStatus): void {
  store.setStatus(task.id, status)
}
</script>

<template>
  <div class="tasks-view">
    <header class="page-header">
      <div>
        <h1 class="page-title">Задачи</h1>
        <p class="page-subtitle">
          Всего: {{ tasks.length }} · Показано: {{ filteredTasks.length }}
        </p>
      </div>
      <BaseButton @click="openCreate">＋ Добавить задачу</BaseButton>
    </header>

    <FilterBar />

    <TransitionGroup
      v-if="filteredTasks.length"
      name="list"
      tag="div"
      class="tasks-view__list"
    >
      <TaskCard
        v-for="task in filteredTasks"
        :key="task.id"
        :task="task"
        @edit="openEdit(task)"
        @remove="handleRemove(task)"
        @update:status="(s) => handleStatusChange(task, s)"
      />
    </TransitionGroup>

    <EmptyState
      v-else-if="tasks.length"
      icon="🔍"
      title="Ничего не найдено"
      subtitle="Измените фильтры или поисковый запрос"
    >
      <template #action>
        <BaseButton variant="ghost" @click="store.resetFilters()">Сбросить фильтры</BaseButton>
      </template>
    </EmptyState>

    <EmptyState
      v-else
      icon="📝"
      title="Пока нет задач"
      subtitle="Создайте первую задачу, чтобы начать"
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
.tasks-view {
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
.tasks-view__list {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* TransitionGroup для карточек */
.list-enter-active,
.list-leave-active {
  transition: all 0.25s ease;
}
.list-enter-from {
  opacity: 0;
  transform: translateX(-12px);
}
.list-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
.list-leave-active {
  position: absolute;
  width: 100%;
}
.list-move {
  transition: transform 0.25s ease;
}
</style>
