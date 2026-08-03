// Утилиты форматирования дат и текста.

const DAY_MS = 86_400_000

/** Форматирование Unix-мс в человекочитаемую дату «03 авг. 2026». */
export function formatDate(ts: number | null): string {
  if (ts === null) return '—'
  return new Date(ts).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/** Относительная дата через Intl.RelativeTimeFormat («через 2 дня», «вчера»). */
export function formatRelative(ts: number): string {
  const diffMs = ts - Date.now()
  const rtf = new Intl.RelativeTimeFormat('ru-RU', { numeric: 'auto' })

  const days = Math.round(diffMs / DAY_MS)
  if (Math.abs(days) >= 1) return rtf.format(days, 'day')

  const hours = Math.round(diffMs / 3_600_000)
  return rtf.format(hours, 'hour')
}

/** Просрочена ли задача (дедлайн в прошлом и задача ещё не выполнена). */
export function isOverdue(dueDate: number | null, status: string): boolean {
  if (dueDate === null || status === 'done') return false
  return dueDate < Date.now()
}

/** Превращает массив тегов в строку через запятую. */
export function joinTags(tags: string[]): string {
  return tags.join(', ')
}
