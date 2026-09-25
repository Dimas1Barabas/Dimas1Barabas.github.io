<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import StatusBadge from '@/entities/booking/ui/StatusBadge.vue';
import { useAppStore } from '@/shared/api/app-mode';
import { useBookingsStore } from '@/entities/booking/model/store';
import ReminderBanner from '@/entities/reminder/ui/ReminderBanner.vue';
import { useReminderStore } from '@/entities/reminder/model/store';
import { useWaitlistStore } from '@/entities/waitlist/model/store';
import {
  formatPrice,
  formatSeats,
  formatSession,
  timeAgo,
} from '@/shared/lib/format';

const store = useBookingsStore();
const waitlist = useWaitlistStore();
const reminder = useReminderStore();
const app = useAppStore();
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  store.startListening();
  // демо-гость: его лист ожидания живёт здесь (в live — в «Моих билетах»)
  if (app.mode === 'demo') {
    waitlist.startListening();
    void waitlist.refresh();
    // и его напоминания «скоро сеанс» — письма движка, как SSE в live
    reminder.startListening();
  }
  tick = setInterval(() => (now.value = Date.now()), 1000);
});

onUnmounted(() => {
  store.stopListening();
  if (app.mode === 'demo') {
    waitlist.stopListening();
    reminder.stopListening();
  }
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
      <div class="stat stat--pending_payment">
        <span class="stat__num">{{ store.stats.PENDING_PAYMENT }}</span>
        <span class="stat__label">ждут оплаты</span>
      </div>
      <div class="stat stat--pending">
        <span class="stat__num">{{ store.stats.PENDING }}</span>
        <span class="stat__label">оплата проводится</span>
      </div>
      <div class="stat stat--confirmed">
        <span class="stat__num">{{ store.stats.CONFIRMED }}</span>
        <span class="stat__label">подтверждено</span>
      </div>
      <div class="stat stat--failed">
        <span class="stat__num">{{ store.stats.FAILED }}</span>
        <span class="stat__label">отказов</span>
      </div>
      <div class="stat stat--expired">
        <span class="stat__num">{{ store.stats.EXPIRED }}</span>
        <span class="stat__label">истекло</span>
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

    <!-- демо-гость: лист ожидания показываем здесь, своего кабинета нет -->
    <div v-if="app.mode === 'demo' && waitlist.lastNotified" class="waitlist-banner" role="status">
      <span class="waitlist-banner__icon" aria-hidden="true">🔔</span>
      <p class="waitlist-banner__text">
        Место освободилось:
        <strong>{{ waitlist.lastNotified.movieTitle }}</strong>,
        {{ waitlist.lastNotified.hall }},
        {{ formatSession(waitlist.lastNotified.sessionAt) }} — успей забронировать!
      </p>
      <RouterLink
        class="btn btn--sm"
        :to="{ path: '/', query: { movie: waitlist.lastNotified.movieId } }"
        @click="waitlist.dismissNotified()"
      >
        Выбрать места
      </RouterLink>
    </div>

    <!-- демо-зеркало письма «скоро сеанс» (в live живёт в «Моих билетах») -->
    <ReminderBanner
      v-if="app.mode === 'demo' && reminder.lastReminded"
      :event="reminder.lastReminded"
      @dismiss="reminder.dismissReminded()"
    />

    <div v-if="app.mode === 'demo' && waitlist.entries.length" class="waitlist-strip">
      <span class="page-sub">Лист ожидания (демо):</span>
      <span
        v-for="entry in waitlist.entries"
        :key="entry.id"
        class="chip"
      >
        {{ entry.movieTitle }} ·
        <template v-if="entry.status === 'WAITING'">
          в очереди<template v-if="entry.position">, {{ entry.position }}-й</template>
        </template>
        <template v-else>место освобождалось!</template>
      </span>
    </div>

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
              {{ booking.customerName }} · {{ booking.hall }},
              {{ formatSession(booking.sessionAt) }} · места
              {{ formatSeats(booking.seats) }} · {{ formatPrice(booking.totalRub) }}
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
            <RouterLink
              v-if="booking.status === 'CONFIRMED'"
              class="btn btn--sm"
              :to="`/ticket/${booking.id}`"
            >
              QR-билеты
            </RouterLink>
            <button
              v-if="booking.status === 'PENDING_PAYMENT' || booking.status === 'CONFIRMED'"
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

<style scoped>
.waitlist-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin: 0 0 14px;
  padding: 12px 16px;
  border: 1px solid hsl(190 80% 50% / 0.45);
  border-radius: 12px;
  background: hsl(190 80% 50% / 0.12);
}

.waitlist-banner__icon {
  font-size: 1.2rem;
}

.waitlist-banner__text {
  margin: 0;
  flex: 1 1 260px;
  line-height: 1.45;
}

.waitlist-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0 0 16px;
}
</style>
