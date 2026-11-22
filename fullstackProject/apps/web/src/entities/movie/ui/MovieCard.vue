<script setup lang="ts">
import type { Movie } from '@/shared/api/types';
import MoviePoster from '@/entities/movie/ui/MoviePoster.vue';
import {
  formatDuration,
  formatPrice,
  formatRating,
  formatSessionsLine,
} from '@/shared/lib/format';

// индекс в сетке — только для stagger-задержки появления
withDefaults(defineProps<{ movie: Movie; index?: number }>(), { index: 0 });
defineEmits<{ book: [movie: Movie]; reviews: [movie: Movie] }>();

/** строка «режиссёр · актёры» внешнего блока, компактно */
function crewLine(external: NonNullable<Movie['external']>): string {
  return [external.director, ...external.actors.slice(0, 2)]
    .filter(Boolean)
    .join(' · ');
}
</script>

<template>
  <article
    class="movie-card"
    :style="{ '--card-i': index }"
  >
    <!-- постер из S3, пока нет — градиент по hue (этап 29) -->
    <MoviePoster
      :movie="movie"
      class="movie-card__poster"
    >
      <span class="movie-card__genre">{{ movie.genre }}</span>
      <span class="movie-card__icon">{{ movie.genreIcon }}</span>
      <span class="movie-card__duration">
        {{ formatDuration(movie.durationMin) }}
      </span>
      <!-- внешний рейтинг справочника (этап 37): звезда-бейдж на постере,
           нет блока — карточка как была (деградация, не сбой) -->
      <span
        v-if="movie.external && movie.external.rating > 0"
        class="movie-card__kp"
        :title="`Рейтинг справочника: ${movie.external.rating} из 10 (${movie.external.votes} оценок)`"
      >
        ★ {{ movie.external.rating.toFixed(1) }}
      </span>
    </MoviePoster>

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

      <!-- внешние метаданные (этап 37): год · страна · возраст, затем команда -->
      <p
        v-if="movie.external"
        class="movie-card__external"
      >
        <span class="movie-card__external-meta">
          {{ [movie.external.year, movie.external.country, movie.external.ageRating]
            .filter(Boolean)
            .join(' · ') }}
        </span>
        <span
          v-if="crewLine(movie.external)"
          class="movie-card__external-crew"
        >
          {{ crewLine(movie.external) }}
        </span>
      </p>

      <p class="movie-card__meta">{{ formatSessionsLine(movie.sessions) }}</p>
      <p class="movie-card__desc">{{ movie.description }}</p>

      <div class="movie-card__footer">
        <span class="movie-card__price">{{ formatPrice(movie.priceRub) }}</span>
        <a
          v-if="movie.external?.trailerUrl"
          class="btn btn--ghost btn--sm movie-card__trailer"
          :href="movie.external.trailerUrl"
          target="_blank"
          rel="noopener"
        >
          Трейлер
        </a>
        <button class="btn" type="button" @click="$emit('book', movie)">
          Забронировать
        </button>
      </div>
    </div>
  </article>
</template>
