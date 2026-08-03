import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  PRIORITY_ORDER,
  type SortDir,
  type SortKey,
  type Task,
  type TaskFilters,
  type TaskInput,
  type TaskStatus,
} from '@/types'

const STORAGE_KEY = 'taskflow:tasks:v1'

/** Генератор id: время + случайная часть — без внешних зависимостей. */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** Стартовые данные, чтобы интерфейс не был пустым при первом запуске. */
function seedTasks(): Task[] {
  const now = Date.now()
  const day = 86_400_000
  return [
    {
      id: uid(),
      title: 'Изучить Composition API',
      description: 'Разобраться с setup-синтаксисом, ref/reactive, computed и watch.',
      status: 'in-progress',
      priority: 'high',
      category: 'Обучение',
      tags: ['vue', 'study'],
      createdAt: now - day * 3,
      dueDate: now + day * 2,
    },
    {
      id: uid(),
      title: 'Настроить Vue Router',
      description: 'Добавить роуты для дашборда, списка задач и канбан-доски.',
      status: 'todo',
      priority: 'medium',
      category: 'Обучение',
      tags: ['vue', 'router'],
      createdAt: now - day * 2,
      dueDate: now + day,
    },
    {
      id: uid(),
      title: 'Сверстать компоненты',
      description: 'BaseButton, BaseInput, TaskCard и т.д.',
      status: 'done',
      priority: 'medium',
      category: 'Вёрстка',
      tags: ['ui'],
      createdAt: now - day * 5,
      dueDate: null,
    },
    {
      id: uid(),
      title: 'Купить кофе',
      description: 'Без него дедлайны не закрываются.',
      status: 'todo',
      priority: 'low',
      category: 'Личное',
      tags: [],
      createdAt: now - day,
      dueDate: null,
    },
  ]
}

/** Чтение из localStorage с защитой от повреждённого JSON. */
function loadTasks(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return seedTasks()
    const parsed = JSON.parse(raw) as Task[]
    return Array.isArray(parsed) ? parsed : seedTasks()
  } catch {
    return seedTasks()
  }
}

export const useTaskStore = defineStore('tasks', () => {
  // --- Состояние ---
  const tasks = ref<Task[]>(loadTasks())

  const filters = ref<TaskFilters>({
    search: '',
    status: 'all',
    priority: 'all',
    category: 'all',
  })

  const sortKey = ref<SortKey>('createdAt')
  const sortDir = ref<SortDir>('desc')

  // --- Персистентность ---
  function persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.value))
  }

  // --- CRUD ---
  function addTask(input: TaskInput): Task {
    const task: Task = {
      id: uid(),
      title: input.title.trim(),
      description: input.description.trim(),
      status: 'todo',
      priority: input.priority,
      category: input.category.trim() || 'Без категории',
      tags: input.tags.map(t => t.trim()).filter(Boolean),
      createdAt: Date.now(),
      dueDate: input.dueDate,
    }
    tasks.value.unshift(task)
    persist()
    return task
  }

  function updateTask(id: string, patch: Partial<TaskInput>): void {
    const index = tasks.value.findIndex(t => t.id === id)
    if (index === -1) return
    tasks.value[index] = { ...tasks.value[index], ...patch }
    persist()
  }

  function removeTask(id: string): void {
    tasks.value = tasks.value.filter(t => t.id !== id)
    persist()
  }

  function setStatus(id: string, status: TaskStatus): void {
    const task = tasks.value.find(t => t.id === id)
    if (task && task.status !== status) {
      task.status = status
      persist()
    }
  }

  function clearCompleted(): void {
    tasks.value = tasks.value.filter(t => t.status !== 'done')
    persist()
  }

  // --- Геттеры ---
  /** Уникальные категории + псевдо-категория 'all' для селекта фильтра. */
  const categories = computed<string[]>(() => {
    const set = new Set<string>()
    for (const t of tasks.value) set.add(t.category)
    return ['all', ...Array.from(set)]
  })

  /** Применяет фильтры и сортировку — основа страницы Tasks. */
  const filteredTasks = computed<Task[]>(() => {
    const { status, priority, category, search } = filters.value
    const query = search.trim().toLowerCase()

    let list = tasks.value.filter(t => {
      if (status !== 'all' && t.status !== status) return false
      if (priority !== 'all' && t.priority !== priority) return false
      if (category !== 'all' && t.category !== category) return false
      if (query) {
        const haystack = `${t.title} ${t.description} ${t.tags.join(' ')}`.toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })

    const dir = sortDir.value === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      let cmp = 0
      switch (sortKey.value) {
        case 'priority':
          cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
          break
        case 'title':
          cmp = a.title.localeCompare(b.title, 'ru')
          break
        case 'dueDate':
          cmp = (a.dueDate ?? Number.POSITIVE_INFINITY) - (b.dueDate ?? Number.POSITIVE_INFINITY)
          break
        default:
          cmp = a.createdAt - b.createdAt
      }
      return cmp * dir
    })
  })

  /** Задачи, сгруппированные по статусу — основа канбан-доски. */
  const tasksByStatus = computed<Record<TaskStatus, Task[]>>(() => {
    const groups: Record<TaskStatus, Task[]> = {
      todo: [],
      'in-progress': [],
      done: [],
    }
    for (const t of tasks.value) groups[t.status].push(t)
    return groups
  })

  /** Сводная статистика для дашборда. */
  const stats = computed(() => {
    let done = 0
    let inProgress = 0
    let todo = 0
    let high = 0
    let overdue = 0
    const now = Date.now()

    for (const t of tasks.value) {
      if (t.status === 'done') {
        done++
        continue
      }
      if (t.status === 'todo') todo++
      if (t.status === 'in-progress') inProgress++
      if (t.priority === 'high') high++
      if (t.dueDate !== null && t.dueDate < now) overdue++
    }

    const total = tasks.value.length
    return {
      total,
      done,
      inProgress,
      todo,
      high,
      overdue,
      completion: total === 0 ? 0 : Math.round((done / total) * 100),
    }
  })

  /** Ближайшие невыполненные задачи с дедлайном — для виджета на дашборде. */
  const upcoming = computed<Task[]>(() =>
    tasks.value
      .filter(t => t.status !== 'done' && t.dueDate !== null)
      .sort((a, b) => (a.dueDate ?? 0) - (b.dueDate ?? 0))
      .slice(0, 5),
  )

  function resetFilters(): void {
    filters.value = { search: '', status: 'all', priority: 'all', category: 'all' }
    sortKey.value = 'createdAt'
    sortDir.value = 'desc'
  }

  function setSort(key: SortKey): void {
    if (sortKey.value === key) {
      sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortKey.value = key
      sortDir.value = 'asc'
    }
  }

  return {
    // состояние
    tasks,
    filters,
    sortKey,
    sortDir,
    // геттеры
    categories,
    filteredTasks,
    tasksByStatus,
    stats,
    upcoming,
    // действия
    addTask,
    updateTask,
    removeTask,
    setStatus,
    clearCompleted,
    resetFilters,
    setSort,
  }
})
