<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import StatusBadge from '../components/StatusBadge.vue';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { useBookingsStore } from '../stores/bookings';
import { formatPrice, formatSeats } from '../utils/format';

const app = useAppStore();
const auth = useAuthStore();
const store = useBookingsStore();

/** кабинет живёт только при живом API и вошедшем пользователе */
const allowed = computed(() => app.mode === 'live' && auth.isAuthed);

onMounted(() => {
  if (!allowed.value) return;
  // тот же SSE-стрим: свои брони обновляются мгновенно, как на табло
  store.startListening();
  void store.refreshMine();
});

onUnmounted(() => {
  if (allowed.value) store.stopListening();
});

function isCancelling(id: string): boolean {
  return store.cancelling.includes(id);
}

async function cancel(id: string): Promise<void> {
  await store.cancel(id);
  await store.refreshMine();
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">Мои билеты</h1>
        <p class="page-sub">
          {{ auth.user?.email }} · статусы приходят мгновенно — Server-Sent Events
        </p>
      </div>
    </div>

    <div v-if="!allowed" class="empty">
      <p class="empty__icon">🎟️</p>
      <p>Личный кабинет доступен после входа при живом API.</p>
      <p class="page-sub">
        В демо-режиме авторизации нет — витрина броней открыта всем.
      </p>
      <RouterLink to="/login" class="btn">Войти</RouterLink>
    </div>

    <template v-else>
      <p v-if="store.mineError" class="hint hint--error">{{ store.mineError }}</p>

      <div v-if="store.mine.length" class="booking-list">
        <TransitionGroup name="list">
          <article
            v-for="booking in store.mine"
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
                места {{ formatSeats(booking.seats) }} · {{ formatPrice(booking.totalRub) }}
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
                @click="cancel(booking.id)"
              >
                {{ isCancelling(booking.id) ? '…' : 'Вернуть билеты' }}
              </button>
              <StatusBadge :status="booking.status" />
            </div>
          </article>
        </TransitionGroup>
      </div>

      <div v-else-if="!store.mineError" class="empty">
        <p class="empty__icon">🍿</p>
        <p>Вы ещё ничего не бронировали.</p>
        <RouterLink to="/" class="btn">Выбрать фильм</RouterLink>
      </div>
    </template>
  </section>
</template>
