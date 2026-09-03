<script setup lang="ts">
import type { Movie } from '../api/types';
import { formatDuration, formatPrice, formatSession } from '../utils/format';

defineProps<{ movie: Movie }>();
defineEmits<{ book: [movie: Movie] }>();
</script>

<template>
  <article class="movie-card">
    <div
      class="movie-card__poster"
      :style="{
        background: `linear-gradient(140deg, hsl(${movie.hue} 70% 55%), hsl(${movie.hue + 55} 65% 30%))`,
      }"
    >
      <span class="movie-card__icon">{{ movie.genreIcon }}</span>
      <span class="movie-card__duration">
        {{ formatDuration(movie.durationMin) }}
      </span>
    </div>

    <div class="movie-card__body">
      <h3 class="movie-card__title" :title="movie.title">
        {{ movie.title }}
      </h3>
      <p class="movie-card__meta">
        {{ movie.genre }} · {{ formatSession(movie.sessionAt) }}
      </p>
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
