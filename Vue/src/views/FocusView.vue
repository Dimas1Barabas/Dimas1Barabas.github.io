<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import { useLocalStorage } from '@/composables/useLocalStorage'

type LoadStatus = 'loading' | 'ready' | 'error'

interface SessionLogEntry {
  at: number
}

const status = ref<LoadStatus>('loading')
const sessions = useLocalStorage<number>('taskflow:focus-sessions', 0)
const log = useLocalStorage<SessionLogEntry[]>('taskflow:focus-log', [])

let scriptEl: HTMLScriptElement | null = null

/** Динамически подключаем собранный Svelte-бандл (микрофронт в рантайме). */
function loadWidget(): void {
  const src = `${import.meta.env.BASE_URL}focus-timer.js`
  scriptEl = document.createElement('script')
  scriptEl.src = src
  scriptEl.async = true
  scriptEl.onload = () => {
    void customElements.whenDefined('focus-timer').then(() => {
      status.value = 'ready'
    })
  }
  scriptEl.onerror = () => {
    status.value = 'error'
  }
  document.head.appendChild(scriptEl)
}

/** Svelte-виджет шлёт CustomEvent «complete» с числом завершённых сессий. */
function onComplete(event: Event): void {
  const detail = (event as CustomEvent<{ sessions: number; mode: string }>).detail
  if (!detail) return
  sessions.value = detail.sessions
  log.value.unshift({ at: Date.now() })
  log.value = log.value.slice(0, 15)
}

function clearLog(): void {
  sessions.value = 0
  log.value = []
}

onMounted(loadWidget)
onBeforeUnmount(() => {
  scriptEl?.remove()
})
</script>

<template>
  <div class="focus-view">
    <header class="page-header">
      <div>
        <h1 class="page-title">Фокус</h1>
        <p class="page-subtitle">Pomodoro-таймер — микровиджет на Svelte внутри Vue</p>
      </div>
    </header>

    <div class="focus-view__grid">
      <BaseCard title="Таймер">
        <Transition name="fade" mode="out-in">
          <div v-if="status === 'loading'" key="loading" class="focus-view__ph">
            <div class="focus-view__spinner" />
            <span>Загрузка Svelte-виджета…</span>
          </div>

          <div
            v-else-if="status === 'error'"
            key="error"
            class="focus-view__ph focus-view__ph--error"
          >
            <p>Не удалось загрузить виджет.</p>
            <p>Соберите его командой <code>pnpm -C focus-timer build</code></p>
          </div>

          <!-- Svelte Custom Element. Событие complete приходит как обычный DOM CustomEvent. -->
          <focus-timer v-else key="widget" @complete="onComplete"></focus-timer>
        </Transition>
      </BaseCard>

      <BaseCard title="Статистика сессий">
        <div class="focus-view__stat">
          <div class="focus-view__stat-value">{{ sessions }}</div>
          <div class="focus-view__stat-label">завершённых фокус-сессий</div>
        </div>

        <p v-if="!log.length" class="focus-view__empty">
          Завершите фокус-сессию на таймере — она появится здесь.
        </p>

        <template v-else>
          <ul class="focus-view__log">
            <li v-for="(item, i) in log" :key="`${item.at}-${i}`">
              🍅 {{ new Date(item.at).toLocaleString('ru-RU') }}
            </li>
          </ul>
          <button class="focus-view__clear" type="button" @click="clearLog">Очистить</button>
        </template>
      </BaseCard>
    </div>

    <BaseCard title="Как это работает">
      <p class="focus-view__text">
        Виджет <code>&lt;focus-timer&gt;</code> — отдельное Svelte-приложение
        (<code>focus-timer/</code>), которое собирается в саморегистрирующийся
        <strong>Custom Element</strong> и кладётся в <code>public/</code>. Vue грузит бандл
        в рантайме через <code>&lt;script&gt;</code> и обменивается данными через обычное
        DOM-событие <code>complete</code>. Тёмная/светлая тема подхватывается автоматически —
        через общие CSS-переменные на <code>&lt;html&gt;</code>.
      </p>
    </BaseCard>
  </div>
</template>

<style scoped>
.focus-view {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.page-header {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.page-title {
  font-size: 1.6rem;
  font-weight: 800;
}
.page-subtitle {
  color: var(--text-muted);
  font-size: 0.95rem;
}
.focus-view__grid {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 1.25rem;
  align-items: start;
}

/* состояния загрузки */
.focus-view__ph {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.85rem;
  padding: 2.5rem 1rem;
  color: var(--text-muted);
  font-size: 0.9rem;
}
.focus-view__ph--error {
  text-align: center;
}
.focus-view__spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* статистика */
.focus-view__stat {
  text-align: center;
  padding: 0.5rem 0 1rem;
}
.focus-view__stat-value {
  font-size: 2.6rem;
  font-weight: 800;
  color: var(--primary);
  line-height: 1;
}
.focus-view__stat-label {
  color: var(--text-muted);
  font-size: 0.9rem;
  margin-top: 0.25rem;
}
.focus-view__empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 0.88rem;
  padding: 0.5rem 0;
}
.focus-view__log {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.88rem;
}
.focus-view__clear {
  margin-top: 0.75rem;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.4rem 0.8rem;
  color: var(--text-muted);
  font-size: 0.82rem;
  cursor: pointer;
}
.focus-view__clear:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.focus-view__text {
  font-size: 0.92rem;
  line-height: 1.7;
  color: var(--text-muted);
}
.focus-view__text code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.1rem 0.35rem;
  font-size: 0.85rem;
  color: var(--text);
}

@media (max-width: 820px) {
  .focus-view__grid {
    grid-template-columns: 1fr;
  }
}
</style>
