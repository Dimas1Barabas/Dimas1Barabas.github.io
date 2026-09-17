<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import StatusBadge from '@/entities/booking/ui/StatusBadge.vue';
import { ApiError } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useBookingsStore } from '@/entities/booking/model/store';
import {
  formatCountdown,
  formatPrice,
  formatSeats,
  formatSession,
} from '@/shared/lib/format';

/**
 * Экран оплаты брони: места уже зарезервированы за клиентом на окно оплаты
 * (expires_at), таймер тикает до дедлайна. Статусы не флипаем сами —
 * вердикт воркера и EXPIRED приходят по SSE (wait-очередь RabbitMQ →
 * booking.expired); на нуле таймера только блокируем кнопку «Оплатить».
 */
const route = useRoute();
const app = useAppStore();
const auth = useAuthStore();
const store = useBookingsStore();

const bookingId = computed(() => String(route.params.bookingId ?? ''));
const booking = computed(
  () =>
    store.mine.find((b) => b.id === bookingId.value) ??
    store.bookings.find((b) => b.id === bookingId.value) ??
    null,
);

/** списки загружены — можно отличить «не нашли» от «ещё грузим» */
const loaded = ref(false);
const paying = ref(false);
const error = ref<string | null>(null);

const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  store.startListening();
  await store.refresh();
  if (app.mode === 'live' && auth.isAuthed) {
    await store.refreshMine();
  }
  loaded.value = true;
  tick = setInterval(() => (now.value = Date.now()), 1000);
});

onUnmounted(() => {
  store.stopListening();
  if (tick) clearInterval(tick);
});

const remainingMs = computed(() =>
  booking.value?.expiresAt
    ? Date.parse(booking.value.expiresAt) - now.value
    : 0,
);
const timeLeft = computed(() => formatCountdown(remainingMs.value));
/** время вышло, но EXPIRED от брокера ещё в пути — не врём, а «проверяем» */
const overdue = computed(
  () => booking.value?.status === 'PENDING_PAYMENT' && remainingMs.value <= 0,
);

function isCancelling(id: string): boolean {
  return store.cancelling.includes(id);
}

async function pay(): Promise<void> {
  if (!booking.value) return;
  paying.value = true;
  error.value = null;
  try {
    await store.pay(booking.value.id);
  } catch (err) {
    if (err instanceof ApiError) {
      // 409 «уже PENDING» — платёж ушёл с первого клика, ждём вердикт по SSE
      try {
        const body = JSON.parse(err.body) as { status?: string };
        if (body.status === 'PENDING') return;
      } catch {
        // тело не JSON — покажем общий текст
      }
    }
    error.value = err instanceof Error ? err.message : 'Не удалось оплатить';
  } finally {
    paying.value = false;
  }
}

async function cancel(): Promise<void> {
  if (!booking.value) return;
  await store.cancel(booking.value.id);
  if (app.mode === 'live' && auth.isAuthed) {
    await store.refreshMine();
  }
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">Оплата брони</h1>
        <p class="page-sub">
          Места держатся за вами до конца окна оплаты, затем бронь истечёт
        </p>
      </div>
    </div>

    <!-- грузим списки, чтобы найти бронь -->
    <div v-if="!booking && !loaded" class="empty">
      <p class="empty__icon">⏳</p>
      <p>Загружаем бронь…</p>
    </div>

    <!-- deep-link на исчезнувшую бронь (список ограничен, GET /:id нет) -->
    <div v-else-if="!booking" class="empty">
      <p class="empty__icon">🎟️</p>
      <p>Бронь не найдена — возможно, она уже вне списков.</p>
      <RouterLink to="/my" class="btn">Мои билеты</RouterLink>
    </div>

    <!-- окно оплаты -->
    <div v-else-if="booking.status === 'PENDING_PAYMENT'" class="pay-card">
      <div class="booking-row">
        <div
          class="booking-row__poster"
          :style="{
            background: `linear-gradient(140deg, hsl(${booking.movieHue} 70% 50%), hsl(${booking.movieHue + 55} 60% 28%))`,
          }"
        >
          {{ booking.movieGenreIcon }}
        </div>
        <div class="booking-row__main">
          <h2 class="booking-row__title">{{ booking.movieTitle }}</h2>
          <p class="booking-row__meta">
            {{ booking.hall }}, {{ formatSession(booking.sessionAt) }} · места
            {{ formatSeats(booking.seats) }}
          </p>
        </div>
        <div class="booking-row__side">
          <StatusBadge :status="booking.status" />
        </div>
      </div>

      <div class="pay-card__summary">
        <span>К оплате</span>
        <strong class="pay-card__total">{{ formatPrice(booking.totalRub) }}</strong>
      </div>

      <p class="pay-timer" :class="{ 'pay-timer--overdue': overdue }">
        <template v-if="overdue">время вышло — проверяем статус…</template>
        <template v-else>оплата в течение {{ timeLeft }}</template>
      </p>

      <p v-if="error" class="hint hint--error">{{ error }}</p>
      <p v-else-if="store.error" class="hint hint--error">{{ store.error }}</p>

      <div class="pay-actions">
        <button
          class="btn"
          :class="{ 'btn--loading': paying }"
          :disabled="paying || overdue"
          :aria-busy="paying"
          @click="pay"
        >
          <span v-if="paying" class="spinner"></span>
          {{ paying ? 'Отправляем…' : `Оплатить ${formatPrice(booking.totalRub)}` }}
        </button>
        <button
          class="btn btn--danger"
          :disabled="isCancelling(booking.id)"
          @click="cancel"
        >
          {{ isCancelling(booking.id) ? '…' : 'Отменить бронь' }}
        </button>
      </div>
    </div>

    <!-- платёж в полёте -->
    <div v-else-if="booking.status === 'PENDING'" class="empty">
      <p class="empty__icon">💳</p>
      <p>Проводим платёж — Go-воркер решает судьбу брони…</p>
      <StatusBadge :status="booking.status" />
    </div>

    <!-- вердикты -->
    <div v-else-if="booking.status === 'CONFIRMED'" class="empty">
      <p class="empty__icon">✅</p>
      <p>Оплата прошла — билеты ваши!</p>
      <p v-if="booking.message" class="page-sub">{{ booking.message }}</p>
      <RouterLink to="/my" class="btn">Мои билеты</RouterLink>
    </div>

    <div v-else-if="booking.status === 'FAILED'" class="empty">
      <p class="empty__icon">✖</p>
      <p>Платёж отклонён — места вернулись в продажу.</p>
      <p v-if="booking.message" class="page-sub">{{ booking.message }}</p>
      <RouterLink to="/" class="btn">Выбрать другие места</RouterLink>
    </div>

    <div v-else-if="booking.status === 'EXPIRED'" class="empty">
      <p class="empty__icon">⌛</p>
      <p>Время оплаты истекло — бронь отменена, места снова в продаже.</p>
      <p v-if="booking.message" class="page-sub">{{ booking.message }}</p>
      <RouterLink to="/" class="btn">Выбрать места заново</RouterLink>
    </div>

    <div v-else class="empty">
      <p class="empty__icon">🚫</p>
      <p>Бронь отменена.</p>
      <p v-if="booking.message" class="page-sub">{{ booking.message }}</p>
      <RouterLink to="/" class="btn">В афишу</RouterLink>
    </div>
  </section>
</template>
