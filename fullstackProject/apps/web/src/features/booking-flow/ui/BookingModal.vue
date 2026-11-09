<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import type { Booking, Movie } from '@/shared/api/types';
import { api, ApiError, retryAfterFrom } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import {
  createDwellClock,
  trackAnalytics,
  type DwellClock,
} from '@/shared/api/analytics';
import {
  formatDayShort,
  formatPrice,
  formatSession,
  formatSeats,
  formatTime,
} from '@/shared/lib/format';
import { useCooldown } from '@/shared/lib/use-cooldown';
import { PROMO_CODE_RE } from '@/shared/lib/promo';
import { spendCap } from '@/shared/lib/bonus';
import { upcomingSessions } from '@/entities/movie/lib/sessions';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useBookingsStore } from '@/entities/booking/model/store';
import { useBonusStore } from '@/entities/bonus/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useWaitlistStore } from '@/entities/waitlist/model/store';
import SeatPicker from '@/features/booking-flow/ui/SeatPicker.vue';

const props = defineProps<{ movie: Movie | null }>();
const emit = defineEmits<{ close: []; created: [booking: Booking] }>();

const appStore = useAppStore();
const authStore = useAuthStore();
const bookingsStore = useBookingsStore();
const bonuses = useBonusStore();
const moviesStore = useMoviesStore();
const waitlistStore = useWaitlistStore();

const customerName = ref('');
const selected = ref<string[]>([]);
/** выбранный сеанс — по нему карта зала и бронь */
const selectedSessionId = ref<string | null>(null);
/**
 * Какой поток оформления в полёте: 'book' — старый (создать бронь),
 * 'buy' — мгновенная покупка. Спиннер рисуется на нажатой кнопке,
 * обе кнопки заморожены — гонки двух потоков на одном выборе нет.
 */
const inFlight = ref<'book' | 'buy' | null>(null);
const submitting = computed(() => inFlight.value !== null);
const error = ref<string | null>(null);
/**
 * Промокод мгновенной покупки: превью здесь нет — брони (и её суммы)
 * до чекаута не существует, код активирует касса в момент оплаты.
 * Отказы (не найден/истёк/исчерпан) вернутся ответом чекаута —
 * бронь к этому моменту уже создана и ждёт оплаты (FR-115).
 */
const promoInput = ref('');
const promoError = ref<string | null>(null);
/** бонусы: потолок «половина суммы» и баланс; списание подтвердит API */
const useBonus = ref(false);
const bonusSpend = ref(0);
const bonusError = ref<string | null>(null);
/**
 * Тумблер «Суфлёра» (флаг checkout.new_flow): показывать ли кнопку
 * мгновенной покупки. Вердикт приезжает при открытии модалки; кнопка
 * видна ровно тогда, когда POST за ней пройдёт гвард — сущность
 * бакетинга у вердикта и гварда одна (id из JWT).
 */
const CHECKOUT_FLAG = 'checkout.new_flow';
const instantFlow = ref(false);
/** кулдаун после 429 Привратника: пока тикает — кнопка брони заморожена */
const { cooldownSec, startCooldown } = useCooldown();
/** сам диалог — фокусируем при открытии, чтобы Esc закрывал без клика */
const modalEl = ref<HTMLElement | null>(null);

/** аналитика: время в модалке (активное, фон не считается) и глубина пути */
let dwellClock: DwellClock | null = null;
let deepestStep: '' | 'session' | 'seats' | 'created' = '';

/** закрытие модалки: dwell с достигнутой глубиной уходит в очередь трекера */
function closeDwell(movieId: string | null): void {
  if (!dwellClock || !movieId) return;
  trackAnalytics('modal_dwell', {
    movieId,
    ms: dwellClock.stop(),
    ...(deepestStep ? { deepest: deepestStep } : {}),
  });
  dwellClock = null;
}

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

/** максимум бонусов к списанию: половина суммы выбора и баланс на счету */
const bonusCap = computed(() => spendCap(total.value, bonuses.balance));
/** блок бонусов есть смысл показывать, когда списать что-то можно */
const bonusAvailable = computed(() => bonusCap.value > 0);
/** сколько реально спишем: ручной ввод зажимаем в [0, cap] */
const clampedSpend = computed(() => {
  const raw = Number(bonusSpend.value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), bonusCap.value);
});
/**
 * Сумма мгновенной покупки: бонусы вычитаем сразу (баланс известен),
 * скидку промокода посчитает касса — до чекаута брони ещё нет.
 */
const payTotal = computed(
  () => total.value - (useBonus.value ? clampedSpend.value : 0),
);

// сумма выбора меняет потолок — зажимаем введённое
watch(bonusCap, (cap) => {
  if (bonusSpend.value > cap) bonusSpend.value = cap;
});
// включили бонусы — по умолчанию предлагаем максимум
watch(useBonus, (on) => {
  if (on) bonusSpend.value = bonusCap.value;
});

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

/** общие проверки оформления (оба потока): null — можно отправлять */
function validateSelection(action: string): string | null {
  if (needLogin.value) {
    return `Войдите, чтобы ${action} — бронь оформляется на ваш профиль`;
  }
  if (askName.value && customerName.value.trim().length < 2) {
    return 'Введите имя (минимум 2 символа)';
  }
  if (!selectedSessionId.value) return 'Нет доступных сеансов';
  if (!selected.value.length) return 'Выберите хотя бы одно место';
  return null;
}

/** подсказки по кодам отказа оплаты (те же коды, что у PaymentView) */
const PROMO_HINTS: Record<string, string> = {
  promoNotFound: 'Промокод не найден',
  promoExpired: 'Срок действия промокода истёк',
  promoExhausted: 'Лимит активаций промокода исчерпан',
};
const BONUS_HINTS: Record<string, string> = {
  bonusOverLimit: 'Бонусами можно закрыть не больше половины суммы',
  bonusInsufficient: 'Не хватает бонусов на счету',
  bonusUnavailable: 'Гостевые брони нельзя оплатить бонусами',
};

/** код ошибки из тела ApiError (null — тело не JSON или кода нет) */
function apiCodeOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const { code } = JSON.parse(err.body) as { code?: string };
    return code ?? null;
  } catch {
    return null;
  }
}

/**
 * Отказ оплаты в чекауте не отменяет бронь: она создана и ждёт
 * PENDING_PAYMENT — тянем свежие списки, чтобы она появилась
 * в «Моих билетах» (повторный чекаут упрётся в 409 тех же мест).
 */
function syncListsAfterPaymentRefusal(): Promise<void> {
  return appStore.mode === 'demo'
    ? bookingsStore.refresh()
    : bookingsStore.refreshMine();
}

/**
 * Разбор отказа оформления — общая кухня обоих потоков: 429 Привратника
 * замораживает форму на retryAfterSec, 409 места фильтрует выбор и
 * тащит свежую карту, остальное — текст ошибки.
 */
function applyFlowError(err: unknown, fallback: string): void {
  const retryAfter = retryAfterFrom(err);
  if (retryAfter !== null) {
    startCooldown(retryAfter);
    error.value = `Слишком много броней — подождите ${retryAfter} с и попробуйте снова`;
    return;
  }
  if (err instanceof ApiError && err.status === 409) {
    // место успели занять прямо под выбором — обновляем карту
    const taken = seatsTakenFrom(err);
    error.value = taken.length
      ? `Места уже заняты: ${formatSeats(taken)} — выберите другие`
      : 'Выбранные места уже заняты — обновите выбор';
    selected.value = selected.value.filter((s) => !taken.includes(s));
    if (selectedSessionId.value) {
      void moviesStore.loadSeats(selectedSessionId.value);
    }
    return;
  }
  error.value = err instanceof Error ? err.message : fallback;
}

async function submit(): Promise<void> {
  if (!props.movie || submitting.value || cooldownSec.value > 0) return;
  const invalid = validateSelection('забронировать');
  if (invalid) {
    error.value = invalid;
    return;
  }
  const sessionId = selectedSessionId.value!; // проверки выше прошли
  // намерение забронировать: места выбраны и отправлены (409/429 — тоже путь)
  trackAnalytics('seats_selected', {
    sessionId,
    count: selected.value.length,
  });
  deepestStep = deepestStep === 'created' ? 'created' : 'seats';
  inFlight.value = 'book';
  error.value = null;
  try {
    const booking = await bookingsStore.create({
      sessionId,
      // в live имя возьмёт из JWT; в демо — как раньше, из поля
      ...(askName.value ? { customerName: customerName.value } : {}),
      seats: selected.value,
    });
    trackAnalytics('booking_created', {
      bookingId: booking.id,
      movieId: props.movie.id,
      sessionId,
    });
    deepestStep = 'created';
    emit('created', booking);
  } catch (err) {
    applyFlowError(err, 'Не удалось создать бронь');
  } finally {
    inFlight.value = null;
  }
}

/**
 * Мгновенная покупка — новый поток оплаты за флагом checkout.new_flow:
 * бронь и оплата одним вызовом, статус ответа PENDING, вердикт Go-воркера
 * покажет экран оплаты (SSE). Отличия от submit — промо/бонусы летят
 * в тот же вызов (скидку посчитает касса) и 403: тумблер могли повернуть
 * между вердиктом витрины и кликом.
 */
async function buyNow(): Promise<void> {
  if (!props.movie || submitting.value || cooldownSec.value > 0) return;
  const invalid = validateSelection('купить');
  if (invalid) {
    error.value = invalid;
    return;
  }
  // формат кода проверяем до отправки — остальное решит касса
  const code = promoInput.value.trim();
  if (code && !PROMO_CODE_RE.test(code)) {
    promoError.value = 'Код: 3–32 символа — латиница, цифры и дефис';
    return;
  }
  const spend =
    useBonus.value && clampedSpend.value > 0 ? clampedSpend.value : undefined;
  const sessionId = selectedSessionId.value!; // проверки выше прошли
  trackAnalytics('seats_selected', {
    sessionId,
    count: selected.value.length,
  });
  deepestStep = deepestStep === 'created' ? 'created' : 'seats';
  inFlight.value = 'buy';
  error.value = null;
  promoError.value = null;
  bonusError.value = null;
  try {
    const booking = await bookingsStore.checkout({
      sessionId,
      ...(askName.value ? { customerName: customerName.value } : {}),
      seats: selected.value,
      ...(code ? { promoCode: code } : {}),
      ...(spend ? { useBonuses: spend } : {}),
    });
    // событие то же, что у старого потока: набор полей закрыт контрактом
    // Аналитика; экран оплаты доошлёт payment_opened — воронка честная
    trackAnalytics('booking_created', {
      bookingId: booking.id,
      movieId: props.movie.id,
      sessionId,
    });
    deepestStep = 'created';
    emit('created', booking);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      // фича ушла из раскатки (kill-switch/откат) — прячем кнопку,
      // старый поток работает как раньше
      instantFlow.value = false;
      error.value =
        'Мгновенная покупка сейчас недоступна — забронируйте обычным способом';
      return;
    }
    // отказ оплаты не прячет бронь (FR-115): она уже создана и ждёт
    // PENDING_PAYMENT — подсказываем путь к дооплате, списки тянем
    const refusal = apiCodeOf(err);
    if (refusal && PROMO_HINTS[refusal]) {
      promoError.value = `${PROMO_HINTS[refusal]} — бронь уже создана и ждёт оплаты, дооплатите её в «Моих билетах»`;
      void syncListsAfterPaymentRefusal();
      return;
    }
    if (refusal && BONUS_HINTS[refusal]) {
      bonusError.value = `${BONUS_HINTS[refusal]} — бронь уже создана и ждёт оплаты, дооплатите её в «Моих билетах»`;
      // баланс могли потратить в другом окне — освежаем и зажимаем ввод
      void bonuses.refresh().then(() => {
        bonusSpend.value = bonusCap.value;
      });
      void syncListsAfterPaymentRefusal();
      return;
    }
    applyFlowError(err, 'Не удалось оформить покупку');
  } finally {
    inFlight.value = null;
  }
}

/**
 * Вердикт тумблера «Суфлёра» для этого пользователя. Анониму и при
 * сбое сети кнопка не показывается — новая фича не «засветится»
 * аварией (fail-safe, как у гварда на маршруте).
 */
async function loadInstantFlow(): Promise<void> {
  if (appStore.mode === 'demo') {
    instantFlow.value = demoEngine.flag(CHECKOUT_FLAG).enabled;
    if (instantFlow.value) void bonuses.refresh(); // потолок бонусов — по балансу
    return;
  }
  if (!authStore.isAuthed) return; // чекаут требует JWT — кнопке нечего открывать
  try {
    instantFlow.value = (await api.flag(CHECKOUT_FLAG)).enabled;
    if (instantFlow.value) void bonuses.refresh();
  } catch {
    instantFlow.value = false;
  }
}

// при каждом открытии — ближайший сеанс, свежая карта зала и пустой выбор
watch(
  () => props.movie,
  async (movie, previous) => {
    // закрытие (в т.ч. переходом на оплату): dwell этой сессии модалки — в очередь
    closeDwell(previous?.id ?? null);
    customerName.value = '';
    selected.value = [];
    error.value = null;
    promoInput.value = '';
    promoError.value = null;
    useBonus.value = false;
    bonusSpend.value = 0;
    bonusError.value = null;
    instantFlow.value = false; // вердикт приезжает заново на каждое открытие
    if (movie) {
      // аналитика: интерес к фильку = открытие модалки; часы — до закрытия
      trackAnalytics('booking_modal_open', { movieId: movie.id });
      dwellClock = createDwellClock();
      deepestStep = '';
      void loadInstantFlow();
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

/** осознанный выбор сеанса (клик по чипу): автодефолт открытия не в счёт */
function pickSession(id: string): void {
  if (id === selectedSessionId.value) return;
  selectedSessionId.value = id;
  trackAnalytics('session_selected', {
    movieId: props.movie?.id,
    sessionId: id,
  });
  if (deepestStep === '') deepestStep = 'session';
}

// тепловая карта мест: каждое добавленное в выбор место — клик по залу
// (эвикция живой картой и 409-фильтр только убирают — diff их не видит)
watch(selected, (next, prev) => {
  const hall = selectedSession.value?.hall;
  if (!selectedSessionId.value || !hall) return;
  for (const seat of next) {
    if (!prev.includes(seat)) {
      trackAnalytics('seat_click', { sessionId: selectedSessionId.value, hall, seat });
    }
  }
});

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
onUnmounted(() => {
  moviesStore.stopSeatStream();
  closeDwell(props.movie?.id ?? null);
});

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
                  @click="pickSession(session.id)"
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

            <!-- промо и бонусы мгновенной покупки: превью нет — брони ещё
                 нет, код и списание применит касса в момент чекаута -->
            <div v-if="instantFlow && selected.length" class="modal__pay">
              <label class="field">
                <span class="field__label">Промокод</span>
                <input
                  v-model="promoInput"
                  class="field__input"
                  type="text"
                  maxlength="32"
                  placeholder="Например, CINE10 — скидку посчитаем при оплате"
                  :disabled="submitting"
                  autocomplete="off"
                />
              </label>
              <p v-if="promoError" class="hint hint--error">{{ promoError }}</p>
              <div v-if="bonusAvailable" class="pay-bonus">
                <label class="pay-bonus__toggle">
                  <input
                    v-model="useBonus"
                    type="checkbox"
                    :disabled="submitting"
                  />
                  <span>
                    Списать бонусы
                    <span class="pay-bonus__balance">
                      {{ bonuses.balance }} на счету · максимум {{ bonusCap }},
                      курс 1 бонус = 1 ₽
                    </span>
                  </span>
                </label>
                <div v-if="useBonus" class="pay-bonus__controls">
                  <input
                    v-model.number="bonusSpend"
                    class="field__input pay-bonus__input"
                    type="number"
                    inputmode="numeric"
                    min="0"
                    :max="bonusCap"
                    :disabled="submitting"
                  />
                  <span class="pay-bonus__cap">
                    не больше половины суммы покупки
                  </span>
                </div>
              </div>
              <p v-if="bonusError" class="hint hint--error">
                {{ bonusError }}
              </p>
            </div>

            <p v-if="error" class="modal__error">{{ error }}</p>

            <p class="modal__note">
              <template v-if="instantFlow">
                «Купить за сумму» — мгновенный чекаут: бронь и оплата одним
                действием, вердикт Go-воркера прилетит на экране оплаты.
                Промокод и бонусы из этой формы применит касса; если оплата
                не пройдёт, бронь не исчезнет — дооплатите её в «Моих
                билетах». «Забронировать» оставит прежний поток: оплата
                отдельным шагом, с превью промокода. Занятые места защищены
                констрейнтом в Postgres — дважды одно место продать нельзя.
              </template>
              <template v-else>
                После создания бронь будет ждать оплаты: места резервируются
                за вами на ограниченное окно, а после оплаты Go-воркер
                ticket-worker «проведёт платёж» и вернёт вердикт. Занятые
                места защищены констрейнтом в Postgres — дважды одно место
                продать нельзя.
              </template>
            </p>
          </div>

          <footer class="modal__foot">
            <span class="modal__total">
              Итого: {{ formatPrice(payTotal) }}
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
              <!-- старый поток живёт: за флагом он младшая кнопка -->
              <button
                v-if="instantFlow"
                class="btn btn--ghost"
                type="button"
                :class="{ 'btn--loading': inFlight === 'book' }"
                :disabled="
                  submitting || cooldownSec > 0 || !selectedSessionId || !selected.length
                "
                :aria-busy="inFlight === 'book' || undefined"
                @click="submit"
              >
                <span
                  v-if="inFlight === 'book'"
                  class="spinner"
                  aria-hidden="true"
                ></span>
                {{ inFlight === 'book' ? 'Отправляем…' : 'Забронировать' }}
              </button>
              <button
                class="btn"
                :class="{ 'btn--loading': submitting }"
                type="button"
                data-testid="primary-action"
                :disabled="
                  submitting || cooldownSec > 0 || !selectedSessionId || !selected.length
                "
                :aria-busy="submitting || undefined"
                @click="instantFlow ? buyNow() : submit()"
              >
                <span
                  v-if="submitting"
                  class="spinner"
                  aria-hidden="true"
                ></span>
                {{
                  submitting
                    ? 'Отправляем…'
                    : cooldownSec
                      ? `Подождите ${cooldownSec} с`
                      : selected.length
                        ? instantFlow
                          ? `Купить за ${formatPrice(payTotal)}`
                          : 'Забронировать'
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
/* промо и бонусы мгновенной покупки */
.modal__pay {
  margin-top: 12px;
}

.modal__pay .field {
  margin-bottom: 0;
}

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
