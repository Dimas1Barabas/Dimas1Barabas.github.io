<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import BookingModal from '../components/BookingModal.vue';
import MovieCard from '../components/MovieCard.vue';
import type { Booking, Movie } from '../api/types';
import { useAuthStore } from '../stores/auth';
import { useMoviesStore } from '../stores/movies';
import { hasSessionOnDate } from '../utils/sessions';

const authStore = useAuthStore();
const moviesStore = useMoviesStore();
const selectedMovie = ref<Movie | null>(null);
const justCreated = ref<Booking | null>(null);
/** выбранный жанр афиши; null — показываем все сеансы */
const selectedGenre = ref<string | null>(null);
/** фильтр по дню: сегодня / завтра / вся неделя */
const dayFilter = ref<'all' | 'today' | 'tomorrow'>('all');

/** жанры афиши в порядке появления — как идут сеансы в каталоге */
const genres = computed<string[]>(() => [
  ...new Set(moviesStore.movies.map((movie) => movie.genre)),
]);

/** выбранный жанр, если он ещё есть в афише (после перезагрузки мог исчезнуть) */
const filteredGenre = computed<string | null>(() =>
  selectedGenre.value && genres.value.includes(selectedGenre.value)
    ? selectedGenre.value
    : null,
);

/** дата фильтра дня — вычисляется раз при отрисовке страницы, этого достаточно */
const filterDate = computed<Date | null>(() => {
  if (dayFilter.value === 'all') return null;
  const d = new Date();
  if (dayFilter.value === 'tomorrow') d.setDate(d.getDate() + 1);
  return d;
});

/** жанр и день работают вместе: фильм подходит, если есть сеанс в этот день */
const filteredMovies = computed<Movie[]>(() =>
  moviesStore.movies.filter(
    (movie) =>
      (!filteredGenre.value || movie.genre === filteredGenre.value) &&
      (!filterDate.value || hasSessionOnDate(movie.sessions, filterDate.value)),
  ),
);

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

    <div
      v-if="!moviesStore.loading && moviesStore.movies.length"
      class="genre-filter day-filter"
    >
      <button
        class="genre-filter__chip"
        :class="{ 'genre-filter__chip--active': dayFilter === 'today' }"
        type="button"
        @click="dayFilter = 'today'"
      >
        Сегодня
      </button>
      <button
        class="genre-filter__chip"
        :class="{ 'genre-filter__chip--active': dayFilter === 'tomorrow' }"
        type="button"
        @click="dayFilter = 'tomorrow'"
      >
        Завтра
      </button>
      <button
        class="genre-filter__chip"
        :class="{ 'genre-filter__chip--active': dayFilter === 'all' }"
        type="button"
        @click="dayFilter = 'all'"
      >
        Вся неделя
      </button>
    </div>

    <div
      v-if="!moviesStore.loading && moviesStore.movies.length"
      class="genre-filter"
    >
      <button
        class="genre-filter__chip"
        :class="{ 'genre-filter__chip--active': !filteredGenre }"
        type="button"
        @click="selectedGenre = null"
      >
        Все
      </button>
      <button
        v-for="genre in genres"
        :key="genre"
        class="genre-filter__chip"
        :class="{ 'genre-filter__chip--active': filteredGenre === genre }"
        type="button"
        @click="selectedGenre = genre"
      >
        {{ genre }}
      </button>
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

    <div v-else-if="!filteredMovies.length" class="empty">
      <div class="empty__icon">🗓️</div>
      <p>В этот день сеансов нет — попробуйте другой фильтр.</p>
    </div>

    <div v-else class="movie-grid">
      <MovieCard
        v-for="(movie, index) in filteredMovies"
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
