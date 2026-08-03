import { ref, watch, type Ref } from 'vue'

/**
 * Реактивный ref, который синхронизирует своё значение с localStorage.
 * Любое изменение записывается автоматически, а при загрузке значение
 * читается из хранилища (с фолбэком на initialValue).
 *
 * @example
 * const name = useLocalStorage<string>('user:name', 'Гость')
 */
export function useLocalStorage<T>(key: string, initialValue: T): Ref<T> {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initialValue : (JSON.parse(raw) as T)
    } catch {
      return initialValue
    }
  }

  const state = ref(read()) as unknown as Ref<T>

  watch(
    state,
    (value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // приватный режим / превышение квоты — просто игнорируем
      }
    },
    { deep: true },
  )

  return state
}
