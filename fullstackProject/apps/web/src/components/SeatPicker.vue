<script setup lang="ts">
import { computed } from 'vue';
import { compareSeats, seatCode } from '../utils/hall';

/**
 * Карта зала: сетка «ряд × место» с занятыми местами и выбором (v-model).
 * Занятое место заблокировано — как строка в seat_occupancy на бэкенде.
 */
const props = withDefaults(
  defineProps<{
    rows: number;
    seatsPerRow: number;
    occupied: string[];
    modelValue: string[];
    max?: number;
  }>(),
  { max: 8 },
);

const emit = defineEmits<{ 'update:modelValue': [seats: string[]] }>();

const occupiedSet = computed(() => new Set(props.occupied));
const selectedSet = computed(() => new Set(props.modelValue));
const full = computed(() => props.modelValue.length >= props.max);

const rows = computed(() =>
  Array.from({ length: props.rows }, (_, r) => ({
    row: r + 1,
    seats: Array.from({ length: props.seatsPerRow }, (_, s) => s + 1),
  })),
);

function isState(row: number, num: number): 'taken' | 'selected' | 'free' {
  const code = seatCode(row, num);
  if (occupiedSet.value.has(code)) return 'taken';
  if (selectedSet.value.has(code)) return 'selected';
  return 'free';
}

function toggle(row: number, num: number): void {
  const code = seatCode(row, num);
  if (occupiedSet.value.has(code)) return;
  const next = new Set(props.modelValue);
  if (next.has(code)) next.delete(code);
  else if (!full.value) next.add(code);
  else return;
  emit('update:modelValue', [...next].sort(compareSeats));
}
</script>

<template>
  <div class="hall" role="group" aria-label="Карта зала">
    <div class="hall__screen">экран</div>
    <div v-for="r in rows" :key="r.row" class="hall__row">
      <span class="hall__row-label">{{ r.row }}</span>
      <button
        v-for="num in r.seats"
        :key="num"
        type="button"
        class="hall__seat"
        :class="`hall__seat--${isState(r.row, num)}`"
        :disabled="isState(r.row, num) === 'taken'"
        :aria-label="`Ряд ${r.row}, место ${num}`"
        :title="`Ряд ${r.row}, место ${num}`"
        @click="toggle(r.row, num)"
      >
        {{ num }}
      </button>
    </div>
    <p class="hall__legend">
      <span><span class="hall__dot hall__dot--free" /> свободно</span>
      <span><span class="hall__dot hall__dot--taken" /> занято</span>
      <span><span class="hall__dot hall__dot--selected" /> ваш выбор</span>
    </p>
  </div>
</template>
