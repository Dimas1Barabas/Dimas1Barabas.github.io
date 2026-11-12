<script setup lang="ts">
/**
 * Постер фильма (этап 29): <img> тянет объект из S3 через публичный
 * GET /movies/:id/poster. Фон блока — градиент по hue фильма: он виден,
 * пока картинка грузится, и остаётся навсегда, если постера нет (404)
 * или хранилище молчит — витрина деградирует, не ломаясь.
 * Демо-режим (Pages без бэкенда) запрос не делает вовсе.
 */
import { computed, ref, watch } from 'vue';
import { useAppStore } from '@/shared/api/app-mode';
import { posterUrl } from '@/shared/api/client';
import type { Movie } from '@/shared/api/types';

const props = defineProps<{ movie: Movie }>();

const app = useAppStore();
const failed = ref(false);
const loaded = ref(false);

// демо-режим: /api/* на Pages отдаёт 404-HTML — запрос не делаем,
// карточке сразу достаточно градиентного фолбэка
const src = computed(() =>
  app.mode === 'live' && !failed.value
    ? posterUrl(props.movie.id)
    : undefined,
);

// карточка переиспользована под другой фильм — пробуем картинку заново
watch(
  () => props.movie.id,
  () => {
    failed.value = false;
    loaded.value = false;
  },
);

/** градиент-фолбэк — тот же вид, что у карточек до этапа 29 */
const gradient = computed(
  () =>
    `linear-gradient(140deg, hsl(${props.movie.hue} 70% 55%), hsl(${props.movie.hue + 55} 65% 30%))`,
);
</script>

<template>
  <div class="movie-poster" :style="{ background: gradient }">
    <img
      v-if="src"
      class="movie-poster__img"
      :class="{ 'movie-poster__img--loaded': loaded }"
      :src="src"
      :alt="`Постер фильма «${movie.title}»`"
      loading="lazy"
      decoding="async"
      @load="loaded = true"
      @error="failed = true"
    >
    <!-- оверлеи карточки (бейджи жанра/длительности) — поверх картинки -->
    <slot />
  </div>
</template>
