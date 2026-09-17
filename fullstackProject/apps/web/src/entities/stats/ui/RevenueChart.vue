<script setup lang="ts">
import { computed } from 'vue';
import type { AdminDayRevenue } from '@/shared/api/types';

/**
 * Столбчатый график выручки за 14 дней — SVG руками, без библиотек.
 * Высота столбца — доля от максимума окна; нулевые дни — точка по оси,
 * последний столбец (сегодня) подсвечен --cyan. Цвета — токены темы,
 * поэтому светлая/тёмная темы работают без правок.
 */
const props = defineProps<{ days: AdminDayRevenue[] }>();

const W = 560;
const H = 190;
const TOP = 14;
const PLOT_H = H - TOP - 36; // под подписи дней остаётся 36px

const slot = computed(() => W / Math.max(props.days.length, 1));
const barW = computed(() => Math.max(4, slot.value * 0.62));
const max = computed(() =>
  Math.max(...props.days.map((d) => d.revenueRub), 1),
);

/** высота столбца: нулевой день — 2px-точка по оси, остальные ≥ 3px */
function barH(revenue: number): number {
  if (revenue <= 0) return 2;
  return Math.max(3, (revenue / max.value) * PLOT_H);
}

const gridYs = [0.25, 0.5, 0.75].map((k) => TOP + PLOT_H * (1 - k));

const bars = computed(() =>
  props.days.map((d, i) => {
    const h = barH(d.revenueRub);
    return {
      key: d.day,
      day: d.day,
      revenueRub: d.revenueRub,
      bookings: d.bookings,
      x: i * slot.value + (slot.value - barW.value) / 2,
      y: TOP + PLOT_H - h,
      width: barW.value,
      height: h,
      zero: d.revenueRub <= 0,
      today: i === props.days.length - 1,
      labelX: i * slot.value + slot.value / 2,
    };
  }),
);

function tooltip(bar: (typeof bars.value)[number]): string {
  const [y, m, d] = bar.day.split('-');
  return `${d}.${m}.${y} — ${bar.revenueRub.toLocaleString('ru-RU')} ₽ · ${bar.bookings} броней`;
}
</script>

<template>
  <svg
    class="chart"
    :viewBox="`0 0 ${W} ${H}`"
    role="img"
    aria-label="Выручка по дням за последние 14 дней"
  >
    <line
      v-for="(y, i) in gridYs"
      :key="i"
      class="chart__grid"
      x1="0"
      :y1="y"
      :x2="W"
      :y2="y"
    />
    <g v-for="bar in bars" :key="bar.key">
      <rect
        class="chart__bar"
        :class="{ 'chart__bar--zero': bar.zero, 'chart__bar--today': bar.today }"
        :x="bar.x"
        :y="bar.y"
        :width="bar.width"
        :height="bar.height"
        rx="2"
      >
        <title>{{ tooltip(bar) }}</title>
      </rect>
      <text
        class="chart__label"
        :class="{ 'chart__label--today': bar.today }"
        :x="bar.labelX"
        :y="H - 10"
        text-anchor="middle"
      >
        {{ bar.day.slice(8) }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.chart {
  display: block;
  width: 100%;
  height: auto;
}

.chart__grid {
  stroke: var(--border);
  stroke-dasharray: 3 5;
}

.chart__bar {
  fill: var(--accent-2);
}

.chart__bar--today {
  fill: var(--cyan);
}

.chart__bar--zero {
  fill: var(--border);
}

.chart__label {
  fill: var(--muted);
  font-size: 11px;
}

.chart__label--today {
  fill: var(--cyan);
  font-weight: 600;
}
</style>
