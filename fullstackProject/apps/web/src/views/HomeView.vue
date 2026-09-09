<script setup lang="ts">
import { onMounted, ref } from 'vue';
import BookingModal from '../components/BookingModal.vue';
import MovieCard from '../components/MovieCard.vue';
import type { Booking, Movie } from '../api/types';
import { useAuthStore } from '../stores/auth';
import { useMoviesStore } from '../stores/movies';

const authStore = useAuthStore();
const moviesStore = useMoviesStore();
const selectedMovie = ref<Movie | null>(null);
const justCreated = ref<Booking | null>(null);

onMounted(() => {
  void moviesStore.load();
});

function onCreated(booking: Booking): void {
  justCreated.value = booking;
  selectedMovie.value = null;
}

function closeToast(): void {
  justCreated.value = null;
}
</script>

<template>
  <section>
    <div class="hero">
      <div aria-hidden="true" class="hero__glow"></div>
      <div aria-hidden="true" class="hero__glow hero__glow--2"></div>
      <h1 class="hero__title">Кино начинается с одного клика</h1>
      <p class="hero__sub">
        CineBooking — учебный фулстек-проект: Vue 3 общается с NestJS API,
        брони уходят в RabbitMQ и подтверждаются Go-воркером, а афиша
        кэшируется в Redis.
      </p>
      <div class="hero__chips">
        <span class="hero__chip">🖥️ Vue 3 + Pinia</span>
        <span class="hero__chip">🧩 NestJS API</span>
        <span class="hero__chip">🐘 PostgreSQL</span>
        <span class="hero__chip">⚡ Redis</span>
        <span class="hero__chip">🐇 RabbitMQ</span>
        <span class="hero__chip">🐹 Go-воркер</span>
      </div>
    </div>

    <div class="page-head">
      <h2 class="page-title">Сеансы на неделю</h2>
      <span
        v-if="!moviesStore.loading && moviesStore.movies.length"
        class="chip"
        :class="moviesStore.source === 'cache' ? 'chip--cache' : 'chip--db'"
      >
        <template v-if="moviesStore.source === 'cache'">
          ⚡ из Redis-кэша
        </template>
        <template v-else> 🐘 из PostgreSQL </template>
      </span>
    </div>

    <!-- скелетоны: заглушки в размер реальной сетки, чтобы не прыгала вёрстка -->
    <div v-if="moviesStore.loading" aria-hidden="true" class="movie-grid">
      <div v-for="i in 6" :key="i" class="skeleton-card">
        <div class="skeleton-card__poster"></div>
        <div class="skeleton-card__body">
          <div class="skeleton-card__line skeleton-card__line--title"></div>
          <div class="skeleton-card__line"></div>
          <div class="skeleton-card__line skeleton-card__line--short"></div>
        </div>
      </div>
    </div>

    <p v-else-if="moviesStore.error" class="hint hint--error">
      {{ moviesStore.error }}
    </p>

    <div v-else-if="!moviesStore.movies.length" class="empty">
      <div class="empty__icon">🎬</div>
      <p>Сеансов пока нет — загляните позже.</p>
      <RouterLink v-if="authStore.isAdmin" class="btn btn--sm" to="/admin">
        Добавить сеанс
      </RouterLink>
    </div>

    <div v-else class="movie-grid">
      <MovieCard
        v-for="(movie, index) in moviesStore.movies"
        :key="movie.id"
        :index="index"
        :movie="movie"
        @book="selectedMovie = $event"
      />
    </div>

    <BookingModal
      :movie="selectedMovie"
      @close="selectedMovie = null"
      @created="onCreated"
    />

    <Transition name="modal">
      <div v-if="justCreated" class="toast" @click="closeToast">
        Бронь создана — статус «в обработке».
        <RouterLink to="/bookings">Следить за бронью →</RouterLink>
      </div>
    </Transition>
  </section>
</template>
