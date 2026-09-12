<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Booking, Movie } from '../api/types';
import { ApiError } from '../api/client';
import {
  formatDayShort,
  formatPrice,
  formatSession,
  formatSeats,
  formatTime,
} from '../utils/format';
import { upcomingSessions } from '../utils/sessions';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { useBookingsStore } from '../stores/bookings';
import { useMoviesStore } from '../stores/movies';
import SeatPicker from './SeatPicker.vue';

const props = defineProps<{ movie: Movie | null }>();
const emit = defineEmits<{ close: []; created: [booking: Booking] }>();

const appStore = useAppStore();
const authStore = useAuthStore();
const bookingsStore = useBookingsStore();
const moviesStore = useMoviesStore();

const customerName = ref('');
const selected = ref<string[]>([]);
/** выбранный сеанс — по нему карта зала и бронь */
const selectedSessionId = ref<string | null>(null);
const submitting = ref(false);
const error = ref<string | null>(null);
/** сам диалог — фокусируем при открытии, чтобы Esc закрывал без клика */
const modalEl = ref<HTMLElement | null>(null);

/** в live-режиме бронь требует JWT: имя и владелец придут из токена */
const needLogin = computed(
  () => appStore.mode === 'live' && !authStore.isAuthed,
);
/** имя спрашиваем только в демо: в live его знает токен */
const askName = computed(() => appStore.mode === 'demo');

const seatMap = computed(() => moviesStore.seatMap);
/** будущие сеансы фильма — чипами в модалке; прошедшие не показываем */
const upcoming = computed(() =>
  props.movie ? upcomingSessions(props.movie.sessions) : [],
);
const selectedSession = computed(
  () => upcoming.value.find((s) => s.id === selectedSessionId.value) ?? null,
);
const total = computed(() =>
  props.movie && seatMap.value
    ? props.movie.priceRub * selected.value.length
    : 0,
);

/** ёмкость и заполненность зала — для мини-бара занятости */
const totalSeats = computed(() =>
  seatMap.value
    ? seatMap.value.layout.rows * seatMap.value.layout.seatsPerRow
    : 0,
);
const occupancyPct = computed(() =>
  totalSeats.value
    ? Math.round(((seatMap.value?.occupied.length ?? 0) / totalSeats.value) * 100)
    : 0,
);

/** снимаем место чипом под картой — как клик по сиденью, только нагляднее */
function dropSeat(code: string): void {
  selected.value = selected.value.filter((seat) => seat !== code);
}

/** список конфликтных мест из тела 409-ответа API */
function seatsTakenFrom(err: unknown): string[] {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { seatsTaken?: string[] };
      if (Array.isArray(body.seatsTaken)) return body.seatsTaken;
    } catch {
      /* тело не JSON — покажем общий текст */
    }
  }
  return [];
}

async function submit(): Promise<void> {
  if (!props.movie || submitting.value) return;
  if (needLogin.value) {
    error.value = 'Войдите, чтобы забронировать — бронь оформляется на ваш профиль';
    return;
  }
  if (askName.value && customerName.value.trim().length < 2) {
    error.value = 'Введите имя (минимум 2 символа)';
    return;
  }
  if (!selectedSessionId.value) {
    error.value = 'Нет доступных сеансов';
    return;
  }
  if (!selected.value.length) {
    error.value = 'Выберите хотя бы одно место';
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    const booking = await bookingsStore.create({
      sessionId: selectedSessionId.value,
      // в live имя возьмёт из JWT; в демо — как раньше, из поля
      ...(askName.value ? { customerName: customerName.value } : {}),
      seats: selected.value,
    });
    emit('created', booking);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // место успели занять прямо под выбором — обновляем карту
      const taken = seatsTakenFrom(err);
      error.value = taken.length
        ? `Места уже заняты: ${formatSeats(taken)} — выберите другие`
        : 'Выбранные места уже заняты — обновите выбор';
      selected.value = selected.value.filter((s) => !taken.includes(s));
      void moviesStore.loadSeats(selectedSessionId.value);
    } else {
      error.value =
        err instanceof Error ? err.message : 'Не удалось создать бронь';
    }
  } finally {
    submitting.value = false;
  }
}

// при каждом открытии — ближайший сеанс, свежая карта зала и пустой выбор
watch(
  () => props.movie,
  async (movie) => {
    customerName.value = '';
    selected.value = [];
    error.value = null;
    if (movie) {
      // дефолт — ближайший будущий сеанс (loadSeats здесь: при переоткрытии
      // того же сеанса watch(selectedSessionId) не сработает — id не сменится)
      selectedSessionId.value = upcomingSessions(movie.sessions)[0]?.id ?? null;
      if (selectedSessionId.value) {
        void moviesStore.loadSeats(selectedSessionId.value);
      }
      await nextTick();
      modalEl.value?.focus({ preventScroll: true });
    }
  },
  { immediate: true },
);

// смена сеанса — своя карта занятости и пустой выбор мест
watch(selectedSessionId, (sessionId) => {
  selected.value = [];
  if (sessionId) void moviesStore.loadSeats(sessionId);
});
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
                <template v-if="selectedSession">
                  · {{ selectedSession.hall }} ·
                  {{ formatSession(selectedSession.startsAt) }}
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
            <p v-if="needLogin" class="modal__login-hint">
              Бронирование доступно после входа: место закрепится за вашим
              аккаунтом, а имя подставится из профиля.
              <RouterLink to="/login">Войти или зарегистрироваться</RouterLink>
            </p>
            <p v-else-if="!askName" class="modal__login-hint">
              Бронь на имя <strong>{{ authStore.user?.name }}</strong> —
              из вашего профиля.
            </p>
            <label v-else class="field">
              <span class="field__label">Ваше имя</span>
              <input
                v-model="customerName"
                class="field__input"
                type="text"
                maxlength="60"
                placeholder="Например, Дмитрий"
              />
            </label>

            <div v-if="upcoming.length" class="field">
              <span class="field__label">Сеанс</span>
              <div class="session-chips">
                <button
                  v-for="session in upcoming"
                  :key="session.id"
                  class="session-chip"
                  type="button"
                  :class="{
                    'session-chip--active': session.id === selectedSessionId,
                  }"
                  @click="selectedSessionId = session.id"
                >
                  <span class="session-chip__when">
                    {{ formatDayShort(session.startsAt) }}
                    {{ formatTime(session.startsAt) }}
                  </span>
                  <span class="session-chip__hall">{{ session.hall }}</span>
                </button>
              </div>
            </div>
            <p v-else class="modal__login-hint">
              Будущих сеансов нет — бронирование закрыто.
            </p>

            <div class="field">
              <span class="field__label">Места (максимум 8)</span>
              <p v-if="moviesStore.seatsLoading" class="hint">
                Загружаем карту зала…
              </p>
              <template v-else-if="seatMap">
                <div
                  class="occupancy"
                  :title="`Занято ${seatMap.occupied.length} из ${totalSeats} мест`"
                >
                  <div class="occupancy__bar">
                    <div
                      class="occupancy__fill"
                      :class="{
                        'occupancy__fill--mid': occupancyPct > 50,
                        'occupancy__fill--high': occupancyPct > 80,
                      }"
                      :style="{ width: `${occupancyPct}%` }"
                    ></div>
                  </div>
                  <span class="occupancy__text">
                    занято {{ seatMap.occupied.length }} из {{ totalSeats }}
                  </span>
                </div>
                <SeatPicker
                  v-model="selected"
                  :rows="seatMap.layout.rows"
                  :seats-per-row="seatMap.layout.seatsPerRow"
                  :occupied="seatMap.occupied"
                  :max="8"
                />
                <div v-if="selected.length" class="modal__seats">
                  <button
                    v-for="seat in selected"
                    :key="seat"
                    class="seat-chip"
                    type="button"
                    :aria-label="`Снять место ${seat}`"
                    @click="dropSeat(seat)"
                  >
                    {{ seat }} <span aria-hidden="true">✕</span>
                  </button>
                </div>
              </template>
              <p v-else-if="error !== null" class="hint hint--error">
                Карта зала недоступна
              </p>
            </div>

            <p v-if="error" class="modal__error">{{ error }}</p>

            <p class="modal__note">
              После создания бронь получит статус «в обработке»: событие уйдёт в
              RabbitMQ, а Go-воркер ticket-worker «проведёт оплату» и вернёт
              вердикт. Занятые места защищены констрейнтом в Postgres — дважды
              одно место продать нельзя.
            </p>
          </div>

          <footer class="modal__foot">
            <span class="modal__total">
              Итого: {{ formatPrice(total) }}
              <template v-if="selected.length">
                · места {{ formatSeats(selected) }}
              </template>
            </span>
            <div class="modal__actions">
              <button
                class="btn btn--ghost"
                type="button"
                @click="emit('close')"
              >
                Отмена
              </button>
              <button
                class="btn"
                :class="{ 'btn--loading': submitting }"
                type="button"
                :disabled="submitting || !selectedSessionId || !selected.length"
                :aria-busy="submitting || undefined"
                @click="submit"
              >
                <span
                  v-if="submitting"
                  class="spinner"
                  aria-hidden="true"
                ></span>
                {{
                  submitting
                    ? 'Отправляем…'
                    : selected.length
                      ? 'Забронировать'
                      : 'Выберите места'
                }}
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
  margin: 0 0 12px;
  color: var(--text-muted, #9aa4b2);
  font-size: 0.92rem;
}

.modal__login-hint a {
  color: inherit;
}
</style>
