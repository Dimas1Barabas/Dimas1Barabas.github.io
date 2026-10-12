<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useBehaviorStore } from '@/entities/behavior/model/store';

/**
 * Витрина «Поведение»: что чаще смотрят и бронируют, где застревают,
 * сколько времени проводят на шагах. В live — только админам (прокси
 * за @Roles('admin')); в демо — всем: цифры детерминированные, страница
 * живёт на Pages как витрина фичи.
 */
const app = useAppStore();
const auth = useAuthStore();
const behavior = useBehaviorStore();
const movies = useMoviesStore();

const allowed = computed(
  () => app.mode === 'demo' || (app.mode === 'live' && auth.isAdmin),
);

onMounted(() => {
  if (allowed.value) void behavior.refresh();
});

const STEP_LABELS: Record<string, string> = {
  modal_open: 'открыли фильм',
  session_selected: 'выбрали сеанс',
  seats_selected: 'выбрали места',
  booking_created: 'забронировали',
  payment_opened: 'открыли оплату',
  paid: 'оплатили',
  confirmed: 'подтверждено',
  failed: 'отказ банка',
};

const funnelMax = computed(
  () => Math.max(...(behavior.insights?.funnel.map((f) => f.count) ?? []), 1),
);

/** названия фильмов из каталога: аналитик знает только id */
const movieTitle = (id: string): string =>
  movies.movies.find((m) => m.id === id)?.title ?? '—';

const opensMax = computed(
  () => Math.max(...(behavior.insights?.movies.map((m) => m.opens) ?? []), 1),
);

/** выбранная пара зала для тепловой карты (первый зал по умолчанию) */
const halls = computed(() => [
  ...new Set(behavior.insights?.seats.map((s) => s.hall) ?? []),
]);
const hall = ref('');
const activeHall = computed(
  () => hall.value || halls.value[0] || '',
);
const seatGrid = computed(() => {
  const bySeat = new Map(
    (behavior.insights?.seats ?? [])
      .filter((s) => s.hall === activeHall.value)
      .map((s) => [s.seat, s.clicks]),
  );
  const maxClicks = Math.max(...bySeat.values(), 1);
  const grid: { seat: string; heat: number }[][] = [];
  for (let row = 1; row <= 8; row++) {
    const line: { seat: string; heat: number }[] = [];
    for (let seat = 1; seat <= 10; seat++) {
      const clicks = bySeat.get(`${row}-${seat}`) ?? 0;
      line.push({ seat: `${row}-${seat}`, heat: clicks / maxClicks });
    }
    grid.push(line);
  }
  return grid;
});

const DEPTH_LABELS: Record<string, string> = {
  session: 'дошли до сеанса',
  seats: 'дошли до мест',
  created: 'довели до брони',
};

function ms(sec: number): string {
  return sec < 60
    ? `${Math.round(sec)} с`
    : `${Math.floor(sec / 60)} мин ${Math.round(sec % 60)} с`;
}
</script>

<template>
  <section class="page">
    <header class="page__head">
      <div>
        <h1>Поведение</h1>
        <p class="page__sub">
          Путь зрителя по витрине: что смотрят, где застревают и что
          превращается в брони. Собирает Go-сервис «Аналитик» из событий
          поведения и транзакционных событий броней.
        </p>
      </div>
      <RouterLink to="/admin/stats" class="page__alt">Выручка и заполняемость →</RouterLink>
    </header>

    <p v-if="!allowed" class="empty">Раздел только для администраторов.</p>
    <p v-else-if="behavior.loading" class="empty">Считаем…</p>
    <p v-else-if="behavior.error" class="empty empty--error">{{ behavior.error }}</p>

    <template v-else-if="behavior.insights">
      <!-- воронка пути зрителя: убывание показывает, где теряем -->
      <h2>Воронка бронирования</h2>
      <ol class="funnel">
        <li
          v-for="row in behavior.insights.funnel"
          :key="row.step"
          class="funnel__row"
        >
          <span class="funnel__label">
            {{ STEP_LABELS[row.step] ?? row.step }}
          </span>
          <span class="funnel__bar">
            <span
              class="funnel__fill"
              :class="{ 'funnel__fill--bad': row.step === 'failed' }"
              :style="{ width: `${Math.max(2, (row.count / funnelMax) * 100)}%` }"
            ></span>
          </span>
          <span class="funnel__count">{{ row.count }}</span>
        </li>
      </ol>

      <!-- интерес против броней: конверсия по каждому фильму -->
      <h2>Интерес к фильмам</h2>
      <table class="table">
        <thead>
          <tr>
            <th>фильм</th>
            <th>смотрели</th>
            <th></th>
            <th>броней</th>
            <th>конверсия</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in behavior.insights.movies" :key="m.movieId">
            <td>{{ movieTitle(m.movieId) }}</td>
            <td>{{ m.opens }}</td>
            <td class="table__bar">
              <span
                class="funnel__fill"
                :style="{ width: `${(m.opens / opensMax) * 100}%` }"
              ></span>
            </td>
            <td>{{ m.bookings }}</td>
            <td>{{ m.conversionPercent }}%</td>
          </tr>
        </tbody>
      </table>

      <div class="two-col">
        <!-- время на маршрутах: активное, фон не считается -->
        <div>
          <h2>Время на страницах</h2>
          <ul class="dwell">
            <li
              v-for="p in behavior.insights.pages"
              :key="p.route"
              class="dwell__row"
            >
              <span class="dwell__route">{{ p.route }}</span>
              <span class="dwell__time">{{ ms(p.avgDwellMs / 1000) }}</span>
              <span class="dwell__views">{{ p.views }} просмотров</span>
            </li>
          </ul>

          <h2>Время в карточке фильма</h2>
          <ul class="dwell">
            <li
              v-for="d in behavior.insights.modal"
              :key="d.deepest"
              class="dwell__row"
            >
              <span class="dwell__route">{{ DEPTH_LABELS[d.deepest] ?? d.deepest }}</span>
              <span class="dwell__time">{{ ms(d.avgMs / 1000) }}</span>
              <span class="dwell__views">{{ d.events }} раз</span>
            </li>
          </ul>
        </div>

        <!-- тепловая карта кликов по местам зала -->
        <div>
          <h2>Популярные места</h2>
          <div class="hall-switch">
            <button
              v-for="h in halls"
              :key="h"
              type="button"
              class="hall-switch__btn"
              :class="{ 'hall-switch__btn--active': h === activeHall }"
              @click="hall = h"
            >
              {{ h }} зал
            </button>
          </div>
          <div class="heat" aria-label="тепловая карта кликов по местам">
            <div v-for="(line, ri) in seatGrid" :key="ri" class="heat__row">
              <span
                v-for="cell in line"
                :key="cell.seat"
                class="heat__cell"
                :style="{ opacity: cell.heat ? 0.15 + cell.heat * 0.85 : 0.06 }"
                :title="`${activeHall} · место ${cell.seat}: ${Math.round(cell.heat * 100)}%`"
              >{{ cell.seat }}</span>
            </div>
          </div>
          <p class="heat__note">
            Темнее — больше кликов: центр зала собирают внимание, края и
            первый ряд — аутсайдеры.
          </p>
        </div>
      </div>
    </template>

    <p v-else-if="!behavior.available" class="empty">
      Аналитик не отвечает — на этом стенде он не поднят или ещё стартует.
    </p>
    <p v-else class="empty">Событий ещё нет: походите по витрине — картина появится.</p>
  </section>
</template>

<style scoped>
.page__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.page__sub {
  max-width: 60ch;
  color: var(--text-muted, #9aa4b2);
}

.page__alt {
  color: inherit;
  font-size: 0.9rem;
  white-space: nowrap;
}

h2 {
  margin: 26px 0 10px;
  font-size: 1.05rem;
}

.funnel {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.funnel__row {
  display: grid;
  grid-template-columns: 140px 1fr 70px;
  align-items: center;
  gap: 10px;
}

.funnel__label {
  font-size: 0.9rem;
}

.funnel__bar {
  height: 18px;
  border-radius: 6px;
  background: rgba(148, 163, 184, 0.12);
  overflow: hidden;
}

.funnel__fill {
  display: block;
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(90deg, hsl(210 70% 55%), hsl(190 70% 45%));
}

.funnel__fill--bad {
  background: linear-gradient(90deg, hsl(10 70% 55%), hsl(30 75% 50%));
}

.funnel__count {
  font-variant-numeric: tabular-nums;
  font-size: 0.9rem;
  text-align: right;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
}

.table th {
  text-align: left;
  font-weight: 600;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.25);
}

.table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}

.table__bar {
  width: 30%;
}

.table__bar .funnel__fill {
  height: 12px;
  min-width: 2px;
}

.two-col {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 28px;
}

.dwell {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.dwell__row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(148, 163, 184, 0.08);
}

.dwell__route {
  font-size: 0.92rem;
}

.dwell__time {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.dwell__views {
  grid-column: 1 / -1;
  color: var(--text-muted, #9aa4b2);
  font-size: 0.8rem;
}

.hall-switch {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.hall-switch__btn {
  padding: 4px 14px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
}

.hall-switch__btn--active {
  border-color: transparent;
  background: rgba(148, 163, 184, 0.25);
}

.heat {
  display: grid;
  gap: 3px;
  justify-items: center;
}

.heat__row {
  display: flex;
  gap: 3px;
}

.heat__cell {
  width: 32px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: hsl(210 75% 50%);
  color: rgba(255, 255, 255, 0.92);
  font-size: 0.62rem;
  user-select: none;
}

.heat__note {
  color: var(--text-muted, #9aa4b2);
  font-size: 0.8rem;
}
</style>
