<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import StatusBadge from '@/entities/booking/ui/StatusBadge.vue';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useBookingsStore } from '@/entities/booking/model/store';
import { useBonusStore } from '@/entities/bonus/model/store';
import ReminderBanner from '@/entities/reminder/ui/ReminderBanner.vue';
import { useReminderStore } from '@/entities/reminder/model/store';
import { useWaitlistStore } from '@/entities/waitlist/model/store';
import type { BonusReason } from '@/shared/api/types';
import {
  formatPrice,
  formatSeats,
  formatSession,
} from '@/shared/lib/format';

const app = useAppStore();
const auth = useAuthStore();
const store = useBookingsStore();
const bonuses = useBonusStore();
const waitlist = useWaitlistStore();
const reminder = useReminderStore();

/** кабинет живёт только при живом API и вошедшем пользователе */
const allowed = computed(() => app.mode === 'live' && auth.isAuthed);

/** человекочитаемые причины движений счёта */
const BONUS_REASONS: Record<BonusReason, string> = {
  cashback: 'кэшбэк за бронь',
  payment: 'оплата бонусами',
  payment_failed: 'возврат — платёж не прошёл',
  refund: 'возврат при отмене брони',
  clawback: 'гашение кэшбэка при возврате',
};

onMounted(() => {
  if (!allowed.value) return;
  // тот же SSE-стрим: свои брони обновляются мгновенно, как на табло
  store.startListening();
  void store.refreshMine();
  // лист ожидания: событие `waitlist` того же стрима + свежие записи
  waitlist.startListening();
  void waitlist.refresh();
  // напоминания: событие `reminder` того же стрима («скоро сеанс»)
  reminder.startListening();
  // бонусный счёт: кэшбэк придет с вердиктом, развороты — с возвратом
  void bonuses.refresh();
});

// вердикты и возвраты меняют баланс — SSE трогает брони, освежаем счёт
watch(
  () => store.mine.map((b) => b.status).join(','),
  () => {
    if (allowed.value) void bonuses.refresh();
  },
);

onUnmounted(() => {
  if (allowed.value) {
    store.stopListening();
    waitlist.stopListening();
    reminder.stopListening();
  }
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
        В демо-режиме билеты гостевые — смотрите раздел «Бронирования».
      </p>
      <RouterLink to="/login" class="btn">Войти</RouterLink>
    </div>

    <template v-else>
      <!-- «место освободилось» голове очереди: место не резерв — успей! -->
      <div v-if="waitlist.lastNotified" class="waitlist-banner" role="status">
        <span class="waitlist-banner__icon" aria-hidden="true">🔔</span>
        <p class="waitlist-banner__text">
          Место освободилось:
          <strong>{{ waitlist.lastNotified.movieTitle }}</strong>,
          {{ waitlist.lastNotified.hall }},
          {{ formatSession(waitlist.lastNotified.sessionAt) }} — успей забронировать!
        </p>
        <div class="waitlist-banner__actions">
          <RouterLink
            class="btn btn--sm"
            :to="{ path: '/', query: { movie: waitlist.lastNotified.movieId } }"
            @click="waitlist.dismissNotified()"
          >
            Выбрать места
          </RouterLink>
          <button
            class="btn btn--ghost btn--sm"
            type="button"
            @click="waitlist.dismissNotified()"
          >
            Позже
          </button>
        </div>
      </div>

      <!-- письмо «скоро сеанс»: подтверждённая бронь, сеанс уже близко -->
      <ReminderBanner
        v-if="reminder.lastReminded"
        :event="reminder.lastReminded"
        @dismiss="reminder.dismissReminded()"
      />

      <div v-if="waitlist.entries.length" class="waitlist-list">
        <h2 class="waitlist-list__title">Лист ожидания</h2>
        <article
          v-for="entry in waitlist.entries"
          :key="entry.id"
          class="waitlist-row"
        >
          <div class="waitlist-row__main">
            <h3 class="waitlist-row__title">{{ entry.movieTitle }}</h3>
            <p class="waitlist-row__meta">
              {{ entry.hall }}, {{ formatSession(entry.startsAt) }} ·
              <template v-if="entry.status === 'WAITING'">
                в очереди<template v-if="entry.position">
                  , позиция {{ entry.position }}</template
                >
              </template>
              <template v-else>
                место освобождалось — вы в честной гонке
              </template>
            </p>
          </div>
          <div class="waitlist-row__side">
            <RouterLink
              class="btn btn--sm"
              :to="{ path: '/', query: { movie: entry.movieId } }"
            >
              Выбрать места
            </RouterLink>
            <button
              class="btn btn--danger btn--sm"
              type="button"
              @click="waitlist.leave(entry.sessionId)"
            >
              Выйти
            </button>
          </div>
        </article>
      </div>

      <!-- бонусный счёт: баланс от источника + история движений ledger'а -->
      <div class="bonus-card">
        <div class="bonus-card__head">
          <h2 class="bonus-card__title">Бонусный счёт</h2>
          <strong class="bonus-card__balance">
            {{ bonuses.balance }}
            <span class="bonus-card__unit">бонусов</span>
          </strong>
        </div>
        <p class="bonus-card__sub">
          1 бонус = 1 ₽ · кэшбэк 5% с подтверждённой брони · списать можно
          до половины чека
        </p>
        <ul v-if="bonuses.transactions.length" class="bonus-card__list">
          <li
            v-for="t in bonuses.transactions"
            :key="t.id"
            class="bonus-card__row"
          >
            <span class="bonus-card__reason">{{ BONUS_REASONS[t.reason] }}</span>
            <span
              class="bonus-card__amount"
              :class="`bonus-card__amount--${t.kind}`"
            >
              {{ t.kind === 'accrual' ? '+' : '−' }}{{ t.amount }}
            </span>
          </li>
        </ul>
      </div>

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
                {{ booking.hall }}, {{ formatSession(booking.sessionAt) }} ·
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
              <RouterLink
                v-if="booking.status === 'PENDING_PAYMENT'"
                class="btn btn--sm"
                :to="`/pay/${booking.id}`"
              >
                Оплатить
              </RouterLink>
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

<style scoped>
/* бонусный счёт: баланс + свежие движения ledger'а */
.bonus-card {
  margin: 0 0 22px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.bonus-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
}

.bonus-card__title {
  margin: 0;
  font-size: 1.05rem;
}

.bonus-card__balance {
  font-size: 1.4rem;
  color: var(--cyan);
}

.bonus-card__unit {
  font-size: 0.85rem;
  font-weight: 400;
  color: var(--muted);
}

.bonus-card__sub {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 0.85rem;
}

.bonus-card__list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bonus-card__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 0.9rem;
}

.bonus-card__reason {
  color: var(--muted);
}

.bonus-card__amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.bonus-card__amount--accrual {
  color: var(--cyan);
}

.bonus-card__amount--spend {
  color: var(--muted);
}

/* «место освободилось» — честная гонка, место не зарезервировано */
.waitlist-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin: 0 0 18px;
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

.waitlist-banner__actions {
  display: flex;
  gap: 8px;
}

.waitlist-list {
  margin-bottom: 26px;
}

.waitlist-list__title {
  margin: 0 0 10px;
  font-size: 1.05rem;
  color: var(--text-muted, #9aa4b2);
}

.waitlist-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 14px;
  padding: 12px 14px;
  border: 1px solid var(--chip-overlay, rgba(148, 163, 184, 0.25));
  border-radius: 12px;
  margin-bottom: 8px;
}

.waitlist-row__title {
  margin: 0 0 4px;
  font-size: 1rem;
}

.waitlist-row__meta {
  margin: 0;
  color: var(--text-muted, #9aa4b2);
  font-size: 0.9rem;
}

.waitlist-row__side {
  display: flex;
  gap: 8px;
}
</style>
