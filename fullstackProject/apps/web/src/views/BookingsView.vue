<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useAppStore } from '../stores/app';
import { useBookingsStore } from '../stores/bookings';
import { formatPrice, formatSeats, timeAgo } from '../utils/format';

const store = useBookingsStore();
const app = useAppStore();
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  store.startListening();
  tick = setInterval(() => (now.value = Date.now()), 1000);
});

onUnmounted(() => {
  store.stopListening();
  if (tick) clearInterval(tick);
});

const updatedAgo = computed(() => timeAgo(store.lastUpdated));

const liveHint = computed(() =>
  app.mode === 'live'
    ? 'Статусы приходят мгновенно — Server-Sent Events, без опроса'
    : 'Статусы приходят мгновенно — локальная симуляция воркера',
);

function isCancelling(id: string): boolean {
  return store.cancelling.includes(id);
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">Мои брони</h1>
        <p class="page-sub">{{ liveHint }}</p>
      </div>
      <span class="chip">обновлено: {{ updatedAgo }}</span>
    </div>

    <div class="stat-row">
      <div class="stat stat--pending">
        <span class="stat__num">{{ store.stats.PENDING }}</span>
        <span class="stat__label">в обработке</span>
      </div>
      <div class="stat stat--confirmed">
        <span class="stat__num">{{ store.stats.CONFIRMED }}</span>
        <span class="stat__label">подтверждено</span>
      </div>
      <div class="stat stat--failed">
        <span class="stat__num">{{ store.stats.FAILED }}</span>
        <span class="stat__label">отказов</span>
      </div>
      <div class="stat stat--cancelling">
        <span class="stat__num">{{ store.stats.CANCELLING }}</span>
        <span class="stat__label">возвраты</span>
      </div>
      <div class="stat stat--cancelled">
        <span class="stat__num">{{ store.stats.CANCELLED }}</span>
        <span class="stat__label">отменено</span>
      </div>
    </div>

    <p v-if="store.error" class="hint hint--error">{{ store.error }}</p>

    <div v-if="store.bookings.length" class="booking-list">
      <TransitionGroup name="list">
        <article
          v-for="booking in store.bookings"
          :key="booking.id"
          class="booking-row"
        >
          <div
            class="booking-row__poster"
            :style="{
              background: `linear-gradient(140deg, hsl(${booking.movieHue} 70% 50%), hsl(${booking.movieHue + 55} 60% 28%))`,
            }"
          >
            {{ booking.movieGenreIcon }}
          </div>

          <div class="booking-row__main">
            <h3 class="booking-row__title">{{ booking.movieTitle }}</h3>
            <p class="booking-row__meta">
              {{ booking.customerName }} · места {{ formatSeats(booking.seats) }}
              · {{ formatPrice(booking.totalRub) }}
            </p>
            <p
              v-if="booking.message"
              class="booking-row__message"
              :class="{ 'booking-row__message--failed': booking.status === 'FAILED' }"
            >
              {{ booking.message }}
              <span v-if="booking.processedBy" class="booking-row__worker">
                · {{ booking.processedBy }}
              </span>
            </p>
          </div>

          <div class="booking-row__side">
            <button
              v-if="booking.status === 'CONFIRMED'"
              class="btn btn--danger btn--sm"
              :disabled="isCancelling(booking.id)"
              @click="store.cancel(booking.id)"
            >
              {{ isCancelling(booking.id) ? '…' : 'Отменить' }}
            </button>
            <StatusBadge :status="booking.status" />
          </div>
        </article>
      </TransitionGroup>
    </div>

    <div v-else-if="!store.error" class="empty">
      <p class="empty__icon">🍿</p>
      <p>Броней пока нет.</p>
      <RouterLink to="/" class="btn">Выбрать фильм</RouterLink>
    </div>
  </section>
</template>
