<script setup lang="ts">
import { onMounted, ref } from 'vue';
import BookingModal from '../components/BookingModal.vue';
import MovieCard from '../components/MovieCard.vue';
import type { Booking, Movie } from '../api/types';
import { useMoviesStore } from '../stores/movies';

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
    <div class="page-head">
      <div>
        <h1 class="page-title">Сеансы на неделю</h1>
        <p class="page-sub">
          Бронирование с асинхронной обработкой: API → RabbitMQ → Go-воркер
        </p>
      </div>
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

    <p v-if="moviesStore.loading" class="hint">Загружаем сеансы…</p>
    <p v-else-if="moviesStore.error" class="hint hint--error">
      {{ moviesStore.error }}
    </p>

    <div v-else class="movie-grid">
      <MovieCard
        v-for="movie in moviesStore.movies"
        :key="movie.id"
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
