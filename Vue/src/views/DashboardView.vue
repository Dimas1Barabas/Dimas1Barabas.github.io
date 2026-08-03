<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useTaskStore } from '@/stores/tasks'
import StatsCard from '@/components/ui/StatsCard.vue'
import BaseCard from '@/components/ui/BaseCard.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import Badge from '@/components/ui/Badge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import { STATUS_LABELS, STATUS_LIST, type TaskStatus } from '@/types'
import { formatDate, formatRelative } from '@/utils/format'

const store = useTaskStore()
const { stats, upcoming, tasksByStatus } = storeToRefs(store)
const router = useRouter()

interface StatusRow {
  status: TaskStatus
  label: string
  count: number
  percent: number
}

/** Распределение задач по статусам для диаграммы. */
const statusRows = computed<StatusRow[]>(() =>
  STATUS_LIST.map((status) => {
    const count = tasksByStatus.value[status].length
    return {
      status,
      label: STATUS_LABELS[status],
      count,
      percent: stats.value.total === 0 ? 0 : Math.round((count / stats.value.total) * 100),
    }
  }),
)

function statusTone(status: TaskStatus): string {
  return status === 'todo' ? 'status-todo' : status === 'in-progress' ? 'status-progress' : 'status-done'
}
</script>

<template>
  <div class="dashboard">
    <header class="page-header">
      <div>
        <h1 class="page-title">Обзор</h1>
        <p class="page-subtitle">Сводка по всем задачам</p>
      </div>
      <BaseButton @click="router.push('/tasks')">К списку задач</BaseButton>
    </header>

    <div class="dashboard__stats">
      <StatsCard label="Всего задач" :value="stats.total" icon="📋" accent="primary" />
      <StatsCard label="Выполнено" :value="`${stats.completion}%`" icon="✅" accent="success" />
      <StatsCard label="В работе" :value="stats.inProgress" icon="⏳" accent="warning" />
      <StatsCard label="Высокий приоритет" :value="stats.high" icon="⚠️" accent="danger" />
      <StatsCard label="Просрочено" :value="stats.overdue" icon="🔥" accent="danger" />
    </div>

    <div class="dashboard__grid">
      <!-- Прогресс выполнения -->
      <BaseCard title="Прогресс выполнения">
        <div class="progress">
          <div class="progress__bar">
            <div class="progress__fill" :style="{ width: `${stats.completion}%` }" />
          </div>
          <div class="progress__meta">
            <span>{{ stats.done }} из {{ stats.total }} выполнено</span>
            <strong>{{ stats.completion }}%</strong>
          </div>
        </div>
      </BaseCard>

      <!-- Распределение по статусам -->
      <BaseCard title="По статусам">
        <ul class="breakdown">
          <li v-for="row in statusRows" :key="row.status" class="breakdown__row">
            <div class="breakdown__label">
              <Badge :tone="statusTone(row.status)">{{ row.label }}</Badge>
              <span class="breakdown__count">{{ row.count }}</span>
            </div>
            <div class="breakdown__bar">
              <div class="breakdown__fill" :class="`bar--${row.status}`" :style="{ width: `${row.percent}%` }" />
            </div>
          </li>
        </ul>
      </BaseCard>
    </div>

    <!-- Ближайшие дедлайны -->
    <BaseCard title="Ближайшие дедлайны">
      <ul v-if="upcoming.length" class="upcoming">
        <li v-for="task in upcoming" :key="task.id" class="upcoming__item">
          <div class="upcoming__info">
            <span class="upcoming__title">{{ task.title }}</span>
            <span class="upcoming__due">
              ⏰ {{ formatDate(task.dueDate) }} · {{ formatRelative(task.dueDate!) }}
            </span>
          </div>
          <Badge tone="primary">{{ task.category }}</Badge>
        </li>
      </ul>
      <EmptyState
        v-else
        icon="🎉"
        title="Нет ближайших дедлайнов"
        subtitle="Задачи без срока или все дедлайны позади"
      />
    </BaseCard>
  </div>
</template>

<style scoped>
.dashboard {
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

.dashboard__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.85rem;
}
.dashboard__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}

/* прогресс */
.progress {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.progress__bar {
  height: 12px;
  background: var(--surface-2);
  border-radius: 999px;
  overflow: hidden;
}
.progress__fill {
  height: 100%;
  background: linear-gradient(90deg, var(--success), var(--primary));
  border-radius: 999px;
  transition: width 0.4s ease;
}
.progress__meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.88rem;
  color: var(--text-muted);
}
.progress__meta strong {
  color: var(--text);
}

/* распределение */
.breakdown {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.breakdown__row {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.breakdown__label {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.breakdown__count {
  font-size: 0.82rem;
  color: var(--text-muted);
}
.breakdown__bar {
  height: 8px;
  background: var(--surface-2);
  border-radius: 999px;
  overflow: hidden;
}
.breakdown__fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s ease;
}
.bar--todo {
  background: var(--status-todo);
}
.bar--in-progress {
  background: var(--status-progress);
}
.bar--done {
  background: var(--status-done);
}

/* дедлайны */
.upcoming {
  display: flex;
  flex-direction: column;
}
.upcoming__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0;
  border-bottom: 1px solid var(--border);
}
.upcoming__item:last-child {
  border-bottom: none;
}
.upcoming__info {
  display: flex;
  flex-direction: column;
}
.upcoming__title {
  font-weight: 600;
}
.upcoming__due {
  font-size: 0.8rem;
  color: var(--text-muted);
}

@media (max-width: 820px) {
  .dashboard__grid {
    grid-template-columns: 1fr;
  }
}
</style>
