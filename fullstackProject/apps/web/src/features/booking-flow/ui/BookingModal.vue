<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import type { Booking, Movie } from '@/shared/api/types';
import { ApiError } from '@/shared/api/client';
import {
  formatDayShort,
  formatPrice,
  formatSession,
  formatSeats,
  formatTime,
} from '@/shared/lib/format';
import { upcomingSessions } from '@/entities/movie/lib/sessions';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useBookingsStore } from '@/entities/booking/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useWaitlistStore } from '@/entities/waitlist/model/store';
import SeatPicker from '@/features/booking-flow/ui/SeatPicker.vue';

const props = defineProps<{ movie: Movie | null }>();
const emit = defineEmits<{ close: []; created: [booking: Booking] }>();

const appStore = useAppStore();
const authStore = useAuthStore();
const bookingsStore = useBookingsStore();
const moviesStore = useMoviesStore();
const waitlistStore = useWaitlistStore();

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
/** квот Тарификатора выбранного сеанса (null — сети нет, покажем базу) */
const quote = computed(() => moviesStore.quote);
/** цена места: квот → база афиши (фолбэк и демо, и деградация live) */
const seatPrice = computed(() =>
  quote.value?.priceRub ?? props.movie?.priceRub ?? 0,
);
const total = computed(() =>
  props.movie && seatMap.value ? seatPrice.value * selected.value.length : 0,
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

/** аншлаг: свободных мест нет — вместо карты мест CTA листа ожидания */
const sessionFull = computed(
  () => seatMap.value !== null && seatMap.value.free === 0,
);
/** своя запись в очереди этого сеанса (WAITING/NOTIFIED) или null */
const myEntry = computed(() =>
  selectedSessionId.value
    ? waitlistStore.entryFor(selectedSessionId.value)
    : null,
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

/** встать в лист ожидания полного сеанса (или заново — после проигранной гонки) */
async function joinQueue(): Promise<void> {
  if (!selectedSessionId.value || waitlistStore.joining) return;
  if (needLogin.value) {
    error.value = 'Войдите, чтобы встать в лист ожидания';
    return;
  }
  error.value = null;
  const ok = await waitlistStore.join(selectedSessionId.value);
  if (!ok && waitlistStore.error) error.value = waitlistStore.error;
}

/** выйти из очереди (запись гасится и в /my) */
async function leaveQueue(): Promise<void> {
  if (!selectedSessionId.value) return;
  await waitlistStore.leave(selectedSessionId.value);
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
        void moviesStore.loadQuote(selectedSessionId.value);
        moviesStore.startSeatStream(
          selectedSessionId.value,
          // демо-«зрители» не занимают места из-под локального выбора
          () => selected.value,
        );
      }
      await nextTick();
      modalEl.value?.focus({ preventScroll: true });
    } else {
      // модалка закрыта — живой карте нечего обновлять
      moviesStore.stopSeatStream();
    }
  },
  { immediate: true },
);

// смена сеанса — своя карта занятости, цена и пустой выбор мест
watch(selectedSessionId, (sessionId) => {
  selected.value = [];
  if (sessionId) {
    void moviesStore.loadSeats(sessionId);
    void moviesStore.loadQuote(sessionId);
    moviesStore.startSeatStream(sessionId, () => selected.value);
  }
});

/**
 * Живая карта: чужая покупка серееет мгновенно. Место, занятое «при мне»,
 * выпадает из выбора с подсказкой — тот же тон, что у 409-ветки submit.
 * Первый снапшот сеанса равен loadSeats — подсказку не вспыхиваем.
 */
const seenOccupied = ref<{ sessionId: string | null; seats: Set<string> }>({
  sessionId: null,
  seats: new Set(),
});
watch(seatMap, (map) => {
  if (!map) {
    seenOccupied.value = { sessionId: null, seats: new Set() };
    return;
  }
  const firstLook = seenOccupied.value.sessionId !== map.sessionId;
  const previous = seenOccupied.value.seats;
  const occupied = new Set(map.occupied);
  seenOccupied.value = { sessionId: map.sessionId, seats: occupied };
  if (firstLook || map.sessionId !== selectedSessionId.value) return;

  if (selected.value.length) {
    const takenNow = selected.value.filter(
      (seat) => occupied.has(seat) && !previous.has(seat),
    );
    if (takenNow.length) {
      error.value = `Место ${formatSeats(takenNow)} только что заняли — выберите другое`;
      selected.value = selected.value.filter((seat) => !takenNow.includes(seat));
    }
  }
});

// страховка: компонент размонтирован (ушли со страницы с открытой модалкой)
onUnmounted(() => moviesStore.stopSeatStream());

/**
 * Заполненность зала дышит (живая карта) — спрос фактор цены, квот
 * перечитывается. Смена сеанса сюда не попадает: её квот грузит
 * watch(selectedSessionId), двойной запрос не нужен.
 */
watch(
  () => [seatMap.value?.sessionId, seatMap.value?.occupied.length] as const,
  ([sessionId], [prevSession]) => {
    if (!sessionId || sessionId !== selectedSessionId.value) return;
    if (sessionId === prevSession && moviesStore.quote) {
      void moviesStore.loadQuote(sessionId);
    }
  },
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

            <!-- цена места: квот Тарификатора с раскладкой факторов;
                 цена фиксируется в момент создания брони -->
            <div v-if="seatPrice" class="price" data-testid="session-price">
              <span class="price__seat">
                Место: {{ formatPrice(seatPrice) }}
                <s
                  v-if="quote && quote.priceRub !== quote.basePriceRub"
                  class="price__base"
                >{{ formatPrice(quote.basePriceRub) }}</s>
              </span>
              <span
                v-for="factor in quote?.factors ?? []"
                :key="factor.code"
                class="price__factor"
                :class="
                  factor.percent < 0
                    ? 'price__factor--down'
                    : 'price__factor--up'
                "
              >{{ factor.label }}</span>
              <span
                v-if="quote && !quote.dynamic"
                class="price__fallback"
                title="Тарификатор недоступен — показываем базовую цену афиши"
              >базовая цена</span>
            </div>

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
                  v-if="!sessionFull"
                  v-model="selected"
                  :rows="seatMap.layout.rows"
                  :seats-per-row="seatMap.layout.seatsPerRow"
                  :occupied="seatMap.occupied"
                  :max="8"
                />
                <div v-if="!sessionFull && selected.length" class="modal__seats">
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
                <div v-if="sessionFull" class="waitlist-cta">
                <p class="waitlist-cta__title">
                  <template v-if="myEntry?.status === 'WAITING'">
                    Вы в очереди<template v-if="myEntry.position">
                      · позиция {{ myEntry.position }}</template
                    >
                  </template>
                  <template v-else-if="myEntry?.status === 'NOTIFIED'">
                    Место освобождалось — успей!
                  </template>
                  <template v-else>Все места заняты</template>
                </p>
                <p class="waitlist-cta__note">
                  <template v-if="myEntry?.status === 'WAITING'">
                    Как только место освободится (бронь истечёт, платёж не
                    пройдёт или кто-то отменит) — первый в очереде получит
                    уведомление в «Моих билетах» и письмом.
                  </template>
                  <template v-else-if="myEntry?.status === 'NOTIFIED'">
                    Место не резервируется — в честной гонке его могли успеть
                    занять. Проверьте карту или встаньте в очередь заново.
                  </template>
                  <template v-else>
                    Место может освободиться: бронь истечёт, платёж не пройдёт
                    или кто-то отменит. Встаньте в лист ожидания — первый в
                    очереди узнает об освобождении первым.
                  </template>
                </p>
                <div class="waitlist-cta__actions">
                  <button
                    v-if="myEntry?.status === 'WAITING'"
                    class="btn btn--ghost"
                    type="button"
                    @click="leaveQueue"
                  >
                    Выйти из очереди
                  </button>
                  <template v-else>
                    <button
                      class="btn"
                      type="button"
                      :class="{ 'btn--loading': waitlistStore.joining }"
                      :disabled="waitlistStore.joining"
                      :aria-busy="waitlistStore.joining || undefined"
                      @click="joinQueue"
                    >
                      {{ waitlistStore.joining ? 'Записываем…' : 'Сообщить о свободном месте' }}
                    </button>
                    <button
                      v-if="myEntry?.status === 'NOTIFIED'"
                      class="btn btn--ghost"
                      type="button"
                      @click="
                        selectedSessionId && moviesStore.loadSeats(selectedSessionId)
                      "
                    >
                      Обновить карту
                    </button>
                  </template>
                </div>
              </div>
              </template>
              <p v-if="seatMap === null && error !== null" class="hint hint--error">
                Карта зала недоступна
              </p>
            </div>

            <p v-if="error" class="modal__error">{{ error }}</p>

            <p class="modal__note">
              После создания бронь будет ждать оплаты: места резервируются за
              вами на ограниченное окно, а после оплаты Go-воркер ticket-worker
              «проведёт платёж» и вернёт вердикт. Занятые места защищены
              констрейнтом в Postgres — дважды одно место продать нельзя.
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

/* цена места: квот Тарификатора + чипы сработавших факторов */
.price {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 0.92rem;
}

.price__seat {
  font-weight: 600;
}

.price__base {
  margin-left: 6px;
  color: var(--text-muted, #9aa4b2);
  font-weight: 400;
}

.price__factor {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  border: 1px solid transparent;
}

.price__factor--up {
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.12);
}

.price__factor--down {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.12);
}

.price__fallback {
  color: var(--text-muted, #9aa4b2);
  font-size: 0.8rem;
  border-bottom: 1px dotted var(--text-muted, #9aa4b2);
  cursor: help;
}

/* аншлаг: вместо карты мест — CTA листа ожидания */
.waitlist-cta {
  margin-top: 10px;
  padding: 14px 16px;
  border: 1px solid var(--chip-overlay, rgba(148, 163, 184, 0.25));
  border-radius: 12px;
  background: var(--chip-overlay, rgba(148, 163, 184, 0.12));
}

.waitlist-cta__title {
  margin: 0 0 6px;
  font-weight: 600;
}

.waitlist-cta__note {
  margin: 0 0 12px;
  color: var(--text-muted, #9aa4b2);
  font-size: 0.9rem;
  line-height: 1.45;
}

.waitlist-cta__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
