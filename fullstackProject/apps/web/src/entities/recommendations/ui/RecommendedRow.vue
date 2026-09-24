<script setup lang="ts">
import type { Movie, RecommendationItem } from '@/shared/api/types';

// карточка топа: фильм афиши + причина рекомендации от КиноСоветника
defineProps<{ entries: { item: RecommendationItem; movie: Movie }[] }>();
defineEmits<{ pick: [movie: Movie] }>();
</script>

<template>
  <div class="recos__row">
    <button
      v-for="{ item, movie } in entries"
      :key="item.movieId"
      class="recos__card"
      type="button"
      @click="$emit('pick', movie)"
    >
      <span
        aria-hidden="true"
        class="recos__poster"
        :style="{
          background: `linear-gradient(140deg, hsl(${movie.hue} 70% 55%), hsl(${movie.hue + 55} 65% 30%))`,
        }"
      >
        <span class="recos__icon">{{ movie.genreIcon }}</span>
      </span>
      <span class="recos__body">
        <span class="recos__title" :title="item.title">{{ item.title }}</span>
        <span class="recos__reason">{{ item.reason }}</span>
      </span>
      <span
        class="recos__score"
        :title="`скор КиноСоветника: ${Math.round(item.score * 100)} из 100`"
      >
        <span
          class="recos__score-fill"
          :style="{ width: `${Math.max(4, Math.round(item.score * 100))}%` }"
        ></span>
      </span>
    </button>
  </div>
</template>

<style scoped>
/* горизонтальная лента компактных карточек — не конкурирует с сеткой афиши */
.recos__row {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: thin;
}

.recos__card {
  display: grid;
  grid-template-columns: 52px 1fr;
  grid-template-rows: auto 4px;
  gap: 4px 10px;
  width: 240px;
  flex: 0 0 auto;
  padding: 10px;
  text-align: left;
  border: 1px solid var(--chip-overlay);
  border-radius: 12px;
  background: var(--btn-bg);
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.recos__card:hover,
.recos__card:focus-visible {
  transform: translateY(-2px);
  border-color: var(--token-cyan, #22d3ee);
}

.recos__poster {
  grid-row: 1 / 3;
  display: grid;
  place-items: center;
  border-radius: 8px;
  font-size: 22px;
}

.recos__icon {
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.4));
}

.recos__body {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.recos__title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recos__reason {
  font-size: 12px;
  color: var(--muted, #9aa4b2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* мини-бар скора: «насколько уверенно» КиноСоветник советует фильм */
.recos__score {
  align-self: end;
  height: 4px;
  border-radius: 2px;
  background: var(--chip-overlay);
  overflow: hidden;
}

.recos__score-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--token-cyan, #22d3ee), #818cf8);
}

@media (prefers-reduced-motion: reduce) {
  .recos__card {
    transition: none;
  }
}
</style>
