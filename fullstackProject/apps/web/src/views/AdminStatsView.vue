<script setup lang="ts">
import { computed, onMounted } from 'vue';
import RevenueChart from '../components/RevenueChart.vue';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { useStatsStore } from '../stores/stats';
import type { AdminStats } from '../api/types';
import { BOOKING_STATUSES } from '../utils/adminStats';
import { formatPrice, formatRating, formatSession } from '../utils/format';

/**
 * Админ-дашборд аналитики: сводка KPI, статусы, график выручки, топ
 * фильмов и заполняемость ближайших сеансов. В live — только админам
 * (эндпоинт за @Roles('admin')); в демо — всем: это витрина Pages,
 * данные считает движок из сидов «других зрителей».
 */
const app = useAppStore();
const auth = useAuthStore();
const stats = useStatsStore();

const allowed = computed(
  () => app.mode === 'demo' || (app.mode === 'live' && auth.isAdmin),
);

onMounted(() => {
  if (allowed.value) void stats.refresh();
});

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: 'ждут оплаты',
  PENDING: 'платёж в полёте',
  CONFIRMED: 'подтверждено',
  FAILED: 'отказ банка',
  EXPIRED: 'истекли',
  CANCELLING: 'возврат',
  CANCELLED: 'отменены',
};

const topMax = computed(() =>
  Math.max(...(stats.admin?.topMovies.map((t) => t.bookings) ?? []), 1),
);

/** цвет полосы заполняемости: зелёная → жёлтая (50%) → красная (80%) */
function fillClass(pct: number): string {
  if (pct >= 80) return 'occupancy__fill--high';
  if (pct >= 50) return 'occupancy__fill--mid';
  return '';
}

function tiles(data: AdminStats): { value: string; label: string; cls: string }[] {
  return [
    { value: formatPrice(data.totals.revenueRub), label: 'выручка', cls: 'stat--revenue' },
    { value: String(data.totals.bookingsTotal), label: 'броней всего', cls: 'stat--total' },
    { value: String(data.totals.confirmed), label: 'подтверждено', cls: 'stat--confirmed' },
    { value: formatPrice(data.totals.avgTicketRub), label: 'средний чек', cls: 'stat--ticket' },
    { value: String(data.totals.seatsSold), label: 'мест продано', cls: 'stat--seats' },
    { value: `${data.totals.upcomingOccupancyPct}%`, label: 'заполняемость впереди', cls: 'stat--occupancy' },
    { value: String(data.totals.moviesCount), label: 'фильмов в афише', cls: 'stat--movies' },
    { value: String(data.totals.reviewsCount), label: 'отзывов', cls: 'stat--reviews' },
    { value: formatRating(data.totals.avgRating), label: 'средняя оценка', cls: 'stat--rating' },
  ];
}
</script>

<template>
  <section class="container stats">
    <div class="stats__head">
      <h1 class="page-title">Аналитика</h1>
      <span v-if="app.mode === 'demo'" class="mode-pill mode-pill--demo">
        демо-данные
      </span>
      <span
        v-if="stats.admin && stats.source === 'cache'"
        class="stats__badge"
        title="Агрегаты кэшируются на 30 секунд — как movies:all в каталоге"
      >
        из кэша
      </span>
      <button
        v-if="allowed"
        class="btn btn--ghost btn--sm"
        type="button"
        :disabled="stats.loading"
        @click="stats.refresh()"
      >
        {{ stats.loading ? 'Считаем…' : 'Обновить' }}
      </button>
    </div>

    <p v-if="!allowed" class="stats__denied">
      Дашборд доступен администраторам —
      <RouterLink to="/login">войдите</RouterLink> под админской учёткой.
    </p>

    <p v-if="stats.error" class="stats__error">
      {{ stats.error }}
      <button class="btn btn--ghost btn--sm" type="button" @click="stats.refresh()">
        Повторить
      </button>
    </p>

    <template v-else-if="stats.admin">
      <div class="stat-row">
        <div v-for="tile in tiles(stats.admin)" :key="tile.label" class="stat" :class="tile.cls">
          <span class="stat__num">{{ tile.value }}</span>
          <span class="stat__label">{{ tile.label }}</span>
        </div>
      </div>

      <h2 class="stats__title">Статусы броней</h2>
      <div class="stat-row">
        <div
          v-for="s in BOOKING_STATUSES"
          :key="s"
          class="stat"
          :class="`stat--${s.toLowerCase()}`"
        >
          <span class="stat__num">{{ stats.admin.byStatus[s] }}</span>
          <span class="stat__label">{{ STATUS_LABELS[s] }}</span>
        </div>
      </div>

      <h2 class="stats__title">Выручка по дням</h2>
      <RevenueChart :days="stats.admin.revenueByDay" />

      <h2 class="stats__title">Топ фильмов</h2>
      <ul v-if="stats.admin.topMovies.length" class="stats__list">
        <li v-for="(m, i) in stats.admin.topMovies" :key="m.movieId" class="stats__row">
          <span class="stats__place">{{ i + 1 }}</span>
          <span class="stats__name">{{ m.title }}</span>
          <span class="occupancy__bar">
            <span
              class="occupancy__fill"
              :style="{ width: `${Math.round((m.bookings / topMax) * 100)}%` }"
            />
          </span>
          <span class="stats__meta">
            {{ m.bookings }} броней · {{ m.seats }} мест · {{ formatPrice(m.revenueRub) }}
          </span>
        </li>
      </ul>
      <p v-else class="stats__empty">Продаж ещё не было — топ пуст</p>

      <h2 class="stats__title">Ближайшие сеансы</h2>
      <ul v-if="stats.admin.upcomingSessions.length" class="stats__list">
        <li
          v-for="s in stats.admin.upcomingSessions"
          :key="s.sessionId"
          class="stats__row"
        >
          <span class="stats__name">
            {{ s.movieTitle }}
            <span class="stats__hall">{{ s.hall }} · {{ formatSession(s.startsAt) }}</span>
          </span>
          <span class="occupancy__bar">
            <span
              class="occupancy__fill"
              :class="fillClass(s.occupancyPct)"
              :style="{ width: `${s.occupancyPct}%` }"
            />
          </span>
          <span class="stats__meta">{{ s.occupied }}/{{ s.capacity }} · {{ s.occupancyPct }}%</span>
        </li>
      </ul>
      <p v-else class="stats__empty">Предстоящих сеансов нет — добавьте новые в /admin</p>
    </template>

    <p v-else-if="allowed" class="stats__empty">Загружаем агрегаты…</p>
  </section>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stats__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.stats__head .page-title {
  margin: 0;
}

.stats__badge {
  font-size: 11px;
  color: var(--muted);
  border: 1px dashed var(--border);
  border-radius: 999px;
  padding: 2px 10px;
}

.stats__denied {
  color: var(--muted);
}

.stats__denied a {
  color: var(--accent);
}

.stats__error {
  color: var(--red);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.stats__title {
  margin: 18px 0 6px;
  font-size: 1.1rem;
}

.stats__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stats__row {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
}

.stats__place {
  font-weight: 700;
  color: var(--muted);
  min-width: 18px;
}

.stats__name {
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stats__hall {
  font-size: 12px;
  color: var(--muted);
}

.stats__meta {
  font-size: 13px;
  color: var(--muted);
  white-space: nowrap;
}

.stats__empty {
  color: var(--muted);
}

/* на узком экране строки складываются в колонку, бар — на всю ширину */
@media (max-width: 640px) {
  .stats__row {
    flex-wrap: wrap;
  }

  .stats__name {
    min-width: 100%;
  }

  .occupancy__bar {
    flex: 1 1 100%;
    order: 3;
  }
}
</style>
