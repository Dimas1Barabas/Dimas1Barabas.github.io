<script setup lang="ts">
import qrcode from 'qrcode-generator';

/**
 * QR-код как чистый SVG: матрица модулей от qrcode-generator (typeNumber 0 —
 * версия подбирается под длину payload), тёмные модули слиты в горизонтальные
 * «пробеги» — один path вместо сотен rect. Отрисовка crispEdges: модули
 * остаются квадратными на любом масштабе, фон всегда светлый — контраст
 * важнее темы интерфейса (сканер «на входе в зал»).
 */
const props = withDefaults(defineProps<{ value: string; pixels?: number }>(), {
  pixels: 240,
});

const qr = qrcode(0, 'M');
qr.addData(props.value);
qr.make();
const count = qr.getModuleCount();

// M{col} {row}h{len}v1h-{len}z — пробег высотой в один модуль
const runs: string[] = [];
for (let row = 0; row < count; row++) {
  let start = -1;
  for (let col = 0; col <= count; col++) {
    const dark = col < count && qr.isDark(row, col);
    if (dark && start === -1) {
      start = col;
    } else if (!dark && start !== -1) {
      runs.push(`M${start} ${row}h${col - start}v1h-${col - start}z`);
      start = -1;
    }
  }
}
const path = runs.join('');
</script>

<template>
  <svg
    class="qr"
    :width="pixels"
    :height="pixels"
    :viewBox="`-1 -1 ${count + 2} ${count + 2}`"
    role="img"
    aria-label="QR-код билета"
    shape-rendering="crispEdges"
  >
    <rect :x="-1" :y="-1" :width="count + 2" :height="count + 2" fill="#fff" />
    <path :d="path" fill="#111" />
  </svg>
</template>
