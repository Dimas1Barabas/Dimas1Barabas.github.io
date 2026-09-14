<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Movie, Review } from '../api/types';
import { ApiError } from '../api/client';
import { formatDayShort, formatRating, pluralizeReviews } from '../utils/format';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { useBookingsStore } from '../stores/bookings';
import { useReviewsStore } from '../stores/reviews';

const props = defineProps<{ movie: Movie | null }>();
const emit = defineEmits<{ close: [] }>();

const appStore = useAppStore();
const authStore = useAuthStore();
const bookingsStore = useBookingsStore();
const reviewsStore = useReviewsStore();

/** форма: звёзды и текст */
const rating = ref(0);
const text = ref('');
const formError = ref<string | null>(null);
/** сам диалог — фокусируем при открытии, чтобы Esc закрывал без клика */
const modalEl = ref<HTMLElement | null>(null);

const reviews = computed(() =>
  props.movie ? reviewsStore.byMovie[props.movie.id] ?? [] : [],
);
const loading = computed(
  () => reviewsStore.loadingFor === props.movie?.id && !reviews.value.length,
);

/**
 * Право на отзыв: подтверждённая бронь на этот фильм. В live — из личного
 * кабинета (mine), в демо — любые свои брони (гость один на всех).
 */
const eligible = computed(() => {
  const movie = props.movie;
  if (!movie) return false;
  if (appStore.mode === 'demo') {
    return bookingsStore.bookings.some(
      (b) => b.movieId === movie.id && b.status === 'CONFIRMED',
    );
  }
  return (
    authStore.isAuthed &&
    bookingsStore.mine.some(
      (b) => b.movieId === movie.id && b.status === 'CONFIRMED',
    )
  );
});

/** свой уже написанный отзыв: форма сменяется пометкой «спасибо» */
const myReview = computed(() => {
  if (!props.movie) return null;
  if (appStore.mode === 'demo') {
    return reviews.value.find((r) => r.userId === 'demo-guest') ?? null;
  }
  const me = authStore.user?.id;
  return me ? (reviews.value.find((r) => r.userId === me) ?? null) : null;
});

/** удалять может автор или админ (в демо — только «гость») */
function canDelete(review: Review): boolean {
  if (appStore.mode === 'demo') return review.userId === 'demo-guest';
  return authStore.isAdmin || review.userId === authStore.user?.id;
}

async function remove(review: Review): Promise<void> {
  if (!props.movie) return;
  await reviewsStore.remove(props.movie.id, review.id);
}

/** сообщение об ошибке из тела ответа API (409/403/400) */
function messageFrom(err: unknown): string | null {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { message?: string };
      if (body.message) return String(body.message);
    } catch {
      /* тело не JSON — общий текст ниже */
    }
  }
  return null;
}

async function submit(): Promise<void> {
  if (!props.movie || reviewsStore.submitting) return;
  if (!rating.value) {
    formError.value = 'Поставьте оценку — от 1 до 5 звёзд';
    return;
  }
  if (text.value.trim().length < 10) {
    formError.value = 'Отзыв слишком короткий — минимум 10 символов';
    return;
  }
  formError.value = null;
  try {
    await reviewsStore.create(props.movie.id, {
      rating: rating.value,
      text: text.value,
    });
    // список и рейтинг обновит стор; форму сбрасываем
    rating.value = 0;
    text.value = '';
  } catch (err) {
    formError.value =
      messageFrom(err) ?? (err instanceof Error ? err.message : 'Не удалось сохранить отзыв');
  }
}

// при каждом открытии — свежий список, право на отзыв и пустая форма
watch(
  () => props.movie,
  async (movie) => {
    rating.value = 0;
    text.value = '';
    formError.value = null;
    if (movie) {
      void reviewsStore.loadFor(movie.id);
      // право на отзыв зависит от броней: подтягиваем актуальные
      if (appStore.mode === 'demo') {
        void bookingsStore.refresh();
      } else if (authStore.isAuthed) {
        void bookingsStore.refreshMine();
      }
      await nextTick();
      modalEl.value?.focus({ preventScroll: true });
    }
  },
  { immediate: true },
);
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="movie"
        class="modal-backdrop"
        @click.self="emit('close')"
        @keydown.esc="emit('close')"
      >
        <div
          ref="modalEl"
          class="modal"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
        >
          <header
            class="modal__head"
            :style="{
              background: `linear-gradient(120deg, hsl(${movie.hue} 70% 45%), hsl(${movie.hue + 55} 60% 25%))`,
            }"
          >
            <span class="modal__icon">{{ movie.genreIcon }}</span>
            <div>
              <h2 class="modal__title">{{ movie.title }}</h2>
              <p class="modal__meta">
                {{ movie.genre }}
                <template v-if="movie.ratingCount">
                  · ★ {{ formatRating(movie.ratingAvg) }} ({{
                    pluralizeReviews(movie.ratingCount)
                  }})
                </template>
              </p>
            </div>
            <button
              class="modal__close"
              type="button"
              aria-label="Закрыть"
              @click="emit('close')"
            >
              ✕
            </button>
          </header>

          <div class="modal__body">
            <p v-if="loading" class="hint">Загружаем отзывы…</p>

            <template v-else>
              <div v-if="reviews.length" class="review-summary">
                <span
                  v-for="i in 5"
                  :key="i"
                  class="rating__star rating__star--lg"
                  :class="{ 'rating__star--filled': i <= Math.round(movie.ratingAvg) }"
                  aria-hidden="true"
                >★</span>
                <span class="review-summary__text">
                  {{ formatRating(movie.ratingAvg) }} ·
                  {{ pluralizeReviews(movie.ratingCount) }}
                </span>
              </div>
              <p v-else class="review-summary__text">
                Отзывов ещё нет — станьте первым.
              </p>

              <ul v-if="reviews.length" class="review-list">
                <li v-for="review in reviews" :key="review.id" class="review-item">
                  <div class="review-item__head">
                    <span class="review-item__author">{{ review.authorName }}</span>
                    <span class="rating">
                      <span
                        v-for="i in 5"
                        :key="i"
                        class="rating__star"
                        :class="{ 'rating__star--filled': i <= review.rating }"
                        aria-hidden="true"
                      >★</span>
                    </span>
                    <time
                      class="review-item__date"
                      :datetime="review.createdAt"
                    >
                      {{ formatDayShort(review.createdAt) }}
                    </time>
                    <button
                      v-if="canDelete(review)"
                      class="btn btn--ghost btn--sm review-item__del"
                      type="button"
                      :disabled="reviewsStore.deleting.includes(review.id)"
                      @click="remove(review)"
                    >
                      Удалить
                    </button>
                  </div>
                  <p class="review-item__text">{{ review.text }}</p>
                </li>
              </ul>

              <p v-if="reviewsStore.error" class="modal__error">
                {{ reviewsStore.error }}
              </p>

              <!-- форма отзыва -->
              <form
                v-if="eligible && !myReview"
                class="review-form"
                @submit.prevent="submit"
              >
                <div class="field">
                  <span class="field__label">Ваша оценка</span>
                  <div class="rating-input">
                    <button
                      v-for="i in 5"
                      :key="i"
                      class="rating-input__star"
                      :class="{ 'rating-input__star--active': i <= rating }"
                      type="button"
                      :aria-label="`${i} из 5`"
                      @click="rating = i"
                    >
                      ★
                    </button>
                  </div>
                </div>
                <label class="field">
                  <span class="field__label">Отзыв</span>
                  <textarea
                    v-model="text"
                    class="field__input"
                    rows="3"
                    maxlength="1000"
                    placeholder="Как вам фильм? Минимум 10 символов"
                  ></textarea>
                </label>
                <p v-if="formError" class="modal__error">{{ formError }}</p>
                <div class="review-form__actions">
                  <button
                    class="btn"
                    :class="{ 'btn--loading': reviewsStore.submitting }"
                    type="submit"
                    :disabled="reviewsStore.submitting || !rating"
                    :aria-busy="reviewsStore.submitting || undefined"
                  >
                    <span
                      v-if="reviewsStore.submitting"
                      class="spinner"
                      aria-hidden="true"
                    ></span>
                    {{ reviewsStore.submitting ? 'Отправляем…' : 'Отправить отзыв' }}
                  </button>
                </div>
              </form>
              <p v-else-if="myReview" class="modal__login-hint">
                Ваш отзыв опубликован — спасибо! Оценку можно изменить, удалив
                текущий отзыв.
              </p>
              <p
                v-else-if="appStore.mode === 'live' && !authStore.isAuthed"
                class="modal__login-hint"
              >
                Отзывы могут писать зрители с подтверждённой бронью.
                <RouterLink to="/login">Войдите</RouterLink> — и оставьте свой.
              </p>
              <p v-else class="modal__login-hint">
                Отзыв можно оставить после подтверждённой брони на этот фильм:
                забронируйте, оплатите — и поделитесь впечатлениями.
              </p>
            </template>
          </div>

          <footer class="modal__foot">
            <span class="modal__total">Отзывы публикуются сразу</span>
            <div class="modal__actions">
              <button
                class="btn btn--ghost"
                type="button"
                @click="emit('close')"
              >
                Закрыть
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal__login-hint {
  margin: 12px 0 0;
  color: var(--text-muted, #9aa4b2);
  font-size: 0.92rem;
}

.modal__login-hint a {
  color: inherit;
}
</style>
