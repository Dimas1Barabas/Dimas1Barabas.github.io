<script setup lang="ts">
import { reactive, watch } from 'vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import {
  PRIORITY_LABELS,
  PRIORITY_LIST,
  type Task,
  type TaskInput,
  type TaskPriority,
} from '@/types'

const props = defineProps<{ task?: Task | null }>()
const emit = defineEmits<{
  submit: [input: TaskInput]
  cancel: []
}>()

interface FormState {
  title: string
  description: string
  priority: TaskPriority
  category: string
  tagsText: string
  dueDate: string
}

function emptyState(): FormState {
  return {
    title: '',
    description: '',
    priority: 'medium',
    category: '',
    tagsText: '',
    dueDate: '',
  }
}

const form = reactive<FormState>(emptyState())
const errors = reactive<{ title?: string }>({})

const priorityOptions = PRIORITY_LIST.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))

/** Приводим Unix-мс к значению input[type=date] (YYYY-MM-DD). */
function toDateInput(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** Синхронизируем форму с переданной задачей (для редактирования). */
function sync(task?: Task | null): void {
  if (task) {
    form.title = task.title
    form.description = task.description
    form.priority = task.priority
    form.category = task.category
    form.tagsText = task.tags.join(', ')
    form.dueDate = toDateInput(task.dueDate)
  } else {
    Object.assign(form, emptyState())
  }
  errors.title = undefined
}

watch(() => props.task, (t) => sync(t), { immediate: true })

function handleSubmit(): void {
  if (!form.title.trim()) {
    errors.title = 'Введите название задачи'
    return
  }
  const input: TaskInput = {
    title: form.title,
    description: form.description,
    priority: form.priority,
    category: form.category,
    tags: form.tagsText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    dueDate: form.dueDate ? new Date(form.dueDate).getTime() : null,
  }
  emit('submit', input)
}
</script>

<template>
  <form class="task-form" @submit.prevent="handleSubmit">
    <BaseInput
      id="task-title"
      v-model="form.title"
      label="Название"
      placeholder="Что нужно сделать?"
      :error="errors.title"
    />

    <BaseTextarea
      id="task-desc"
      v-model="form.description"
      label="Описание"
      placeholder="Детали задачи (необязательно)"
      :rows="3"
    />

    <div class="task-form__row">
      <BaseSelect id="task-priority" v-model="form.priority" label="Приоритет" :options="priorityOptions" />
      <BaseInput id="task-category" v-model="form.category" label="Категория" placeholder="Напр. Работа" />
    </div>

    <BaseInput
      id="task-due"
      v-model="form.dueDate"
      label="Срок"
      type="date"
    />

    <BaseInput
      id="task-tags"
      v-model="form.tagsText"
      label="Теги"
      placeholder="через запятую: vue, срочно"
      hint="Теги помогут искать задачи"
    />

    <div class="task-form__actions">
      <BaseButton variant="ghost" type="button" @click="emit('cancel')">Отмена</BaseButton>
      <BaseButton type="submit">{{ props.task ? 'Сохранить' : 'Добавить' }}</BaseButton>
    </div>
  </form>
</template>

<style scoped>
.task-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.task-form__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
.task-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 0.25rem;
}
@media (max-width: 480px) {
  .task-form__row {
    grid-template-columns: 1fr;
  }
}
</style>
