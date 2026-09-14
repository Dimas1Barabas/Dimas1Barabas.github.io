<script setup lang="ts">
import type { Movie } from '../api/types';
import {
  formatDuration,
  formatPrice,
  formatRating,
  formatSessionsLine,
} from '../utils/format';

// индекс в сетке — только для stagger-задержки появления
withDefaults(defineProps<{ movie: Movie; index?: number }>(), { index: 0 });
defineEmits<{ book: [movie: Movie]; reviews: [movie: Movie] }>();
</script>

<template>
  <article
    class="movie-card"
    :style="{ '--card-i': index }"
  >
    <div
      class="movie-card__poster"
      :style="{
        background: `linear-gradient(140deg, hsl(${movie.hue} 70% 55%), hsl(${movie.hue + 55} 65% 30%))`,
      }"
    >
      <span class="movie-card__genre">{{ movie.genre }}</span>
      <span class="movie-card__icon">{{ movie.genreIcon }}</span>
      <span class="movie-card__duration">
        {{ formatDuration(movie.durationMin) }}
      </span>
    </div>

    <div class="movie-card__body">
      <h3 class="movie-card__title" :title="movie.title">
        {{ movie.title }}
      </h3>
      <button
        class="movie-card__rating"
        type="button"
        :aria-label="
          movie.ratingCount
            ? `Отзывы: ${formatRating(movie.ratingAvg)} из 5, ${movie.ratingCount}`
            : 'Отзывов ещё нет — открыть отзывы'
        "
        @click="$emit('reviews', movie)"
      >
        <template v-if="movie.ratingCount > 0">
          <span
            v-for="i in 5"
            :key="i"
            class="rating__star"
            :class="{ 'rating__star--filled': i <= Math.round(movie.ratingAvg) }"
            aria-hidden="true"
          >★</span>
          <span class="movie-card__rating-count">
            {{ formatRating(movie.ratingAvg) }} · {{ movie.ratingCount }}
          </span>
        </template>
        <template v-else>
          <span class="rating__star" aria-hidden="true">★</span>
          <span class="movie-card__rating-count">Отзывов ещё нет</span>
        </template>
      </button>
      <p class="movie-card__meta">{{ formatSessionsLine(movie.sessions) }}</p>
      <p class="movie-card__desc">{{ movie.description }}</p>

      <div class="movie-card__footer">
        <span class="movie-card__price">{{ formatPrice(movie.priceRub) }}</span>
        <button class="btn" type="button" @click="$emit('book', movie)">
          Забронировать
        </button>
      </div>
    </div>
  </article>
</template>
