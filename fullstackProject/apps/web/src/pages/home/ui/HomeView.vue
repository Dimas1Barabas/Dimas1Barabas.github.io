<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BookingModal from '@/features/booking-flow/ui/BookingModal.vue';
import MovieCard from '@/entities/movie/ui/MovieCard.vue';
import RecommendedRow from '@/entities/recommendations/ui/RecommendedRow.vue';
import ReviewModal from '@/features/review/ui/ReviewModal.vue';
import type { Booking, Movie } from '@/shared/api/types';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useRecommendationsStore } from '@/entities/recommendations/model/store';
import { hasSessionOnDate } from '@/entities/movie/lib/sessions';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const moviesStore = useMoviesStore();
const recosStore = useRecommendationsStore();
const selectedMovie = ref<Movie | null>(null);
/** фильм, чьи отзывы открыты в модалке */
const reviewMovie = ref<Movie | null>(null);
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

/** топ «Вам понравится» обогащаем фильмами афиши (постер, жанр-иконка) */
const recoEntries = computed(() =>
  recosStore.items
    .map((item) => ({
      item,
      movie: moviesStore.movies.find((m) => m.id === item.movieId),
    }))
    .filter((e): e is { item: (typeof recosStore.items)[number]; movie: Movie } =>
      Boolean(e.movie),
    ),
);

/** подпись блока: на чём КиноСоветник построил топ */
const recosHint = computed(() =>
  recosStore.basis === 'profile'
    ? 'по вашим броням и отзывам'
    : 'популярное сейчас',
);

onMounted(() => {
  // Promise.resolve: и живой промис, и мок без возврата — оба подходят
  void Promise.resolve(moviesStore.load()).then(openFromQuery);
  // рекомендации — только вошедшим (демо-сессия считается входом)
  if (authStore.isAuthed) void recosStore.refresh();
});

// вход/выход меняет профиль — подтягиваем или прячем блок
watch(
  () => authStore.isAuthed,
  (authed) => {
    void recosStore.refresh();
    if (!authed) {
      recosStore.items = [];
      recosStore.loaded = false;
    }
  },
);

/** ?movie=<id> — глубокая ссылка из письма/уведомления листа ожидания:
 *  афиша загружена → сразу открываем модалку выбора мест */
function openFromQuery(): void {
  const wanted = route.query.movie;
  if (typeof wanted !== 'string' || selectedMovie.value) return;
  const movie = moviesStore.movies.find((m) => m.id === wanted);
  if (movie) {
    selectedMovie.value = movie;
    // ссылка одноразовая: после закрытия модалки не открываем снова
    void router.replace({ query: { ...route.query, movie: undefined } });
  }
}

/** бронь создана — ведём клиента оплачивать, окно резерва уже тикает */
function onCreated(booking: Booking): void {
  selectedMovie.value = null;
  void router.push({ name: 'pay', params: { bookingId: booking.id } });
}

/** клик по карточке «Вам понравится» — та же модалка выбора мест */
function openReco(movie: Movie): void {
  selectedMovie.value = movie;
}
</script>

<template>
  <section>
    <div class="hero">
      <div aria-hidden="true" class="hero__glow"></div>
      <div aria-hidden="true" class="hero__glow hero__glow--2"></div>
      <h1 class="hero__title">Кино начинается с одного клика</h1>
      <p class="hero__sub">
        Выбирайте фильм, занимайте лучшие места на схеме зала и оплачивайте
        онлайн — статус брони обновляется в реальном времени.
      </p>
    </div>

    <!-- КиноСоветник: персональный топ для вошедшего зрителя -->
    <section v-if="recosStore.visible && recoEntries.length" class="recos">
      <div class="page-head">
        <h2 class="page-title">Вам понравится</h2>
        <span class="hint recos__hint">{{ recosHint }}</span>
      </div>
      <RecommendedRow :entries="recoEntries" @pick="openReco" />
    </section>

    <div class="page-head">
      <h2 class="page-title">Сеансы на неделю</h2>
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
        @reviews="reviewMovie = $event"
      />
    </div>

    <BookingModal
      :movie="selectedMovie"
      @close="selectedMovie = null"
      @created="onCreated"
    />

    <ReviewModal :movie="reviewMovie" @close="reviewMovie = null" />
  </section>
</template>

<style scoped>
.recos__hint {
  align-self: center;
}
</style>
