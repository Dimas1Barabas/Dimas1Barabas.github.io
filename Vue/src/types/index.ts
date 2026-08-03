// Доменные типы приложения TaskFlow.

/** Статус задачи — соответствует колонкам канбан-доски. */
export type TaskStatus = 'todo' | 'in-progress' | 'done'

/** Приоритет задачи. */
export type TaskPriority = 'low' | 'medium' | 'high'

/** Полная сущность задачи, хранится в localStorage. */
export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  category: string
  tags: string[]
  /** Unix-мс создания. */
  createdAt: number
  /** Unix-мс дедлайна или null, если дедлайна нет. */
  dueDate: number | null
}

/** Данные формы — то, что вводит пользователь при создании/редактировании. */
export interface TaskInput {
  title: string
  description: string
  priority: TaskPriority
  category: string
  tags: string[]
  dueDate: number | null
}

/** Поле сортировки списка задач. */
export type SortKey = 'createdAt' | 'priority' | 'dueDate' | 'title'
export type SortDir = 'asc' | 'desc'

/** Активные фильтры списка. Значение 'all' — фильтр не применён. */
export interface TaskFilters {
  search: string
  status: TaskStatus | 'all'
  priority: TaskPriority | 'all'
  category: string | 'all'
}

// --- Справочники для отображения ---

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'К выполнению',
  'in-progress': 'В работе',
  done: 'Готово',
}

export const STATUS_LIST: TaskStatus[] = ['todo', 'in-progress', 'done']

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Низкий',
  medium: 'Средний',
  high: 'Высокий',
}

export const PRIORITY_LIST: TaskPriority[] = ['low', 'medium', 'high']
