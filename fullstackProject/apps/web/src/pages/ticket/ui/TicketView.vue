<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import QrCode from '@/shared/ui/QrCode.vue';
import { useTicketsStore } from '@/entities/ticket/model/tickets.store';
import { formatSession } from '@/shared/lib/format';
import { ticketQrOf } from '@/shared/lib/ticket';
import type { Ticket } from '@/shared/api/types';

const route = useRoute();
const store = useTicketsStore();

const bookingId = computed(() => String(route.params.bookingId ?? ''));

/** место, чей QR раскрыт «во весь экран» — режим «у входа в зал» */
const zoomedSeat = ref<string | null>(null);
const fullscreenEl = ref<HTMLElement | null>(null);

onMounted(() => {
  store.clear();
  void store.load(bookingId.value);
});

const zoomedTicket = computed<Ticket | null>(() =>
  zoomedSeat.value
    ? store.tickets.find((t) => t.seat === zoomedSeat.value) ?? null
    : null,
);

/** фокус внутрь оверлея — Esc закрывает без предварительного клика */
watch(zoomedSeat, async (seat) => {
  if (seat) {
    await nextTick();
    fullscreenEl.value?.focus({ preventScroll: true });
  }
});

function closeZoom(): void {
  zoomedSeat.value = null;
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">Билеты на вход</h1>
        <p class="page-sub">
          Покажите QR-код контролёру у зала · по одному на каждое место
        </p>
      </div>
    </div>

    <div v-if="store.loading" class="empty">
      <p class="empty__icon">⏳</p>
      <p>Загружаем билеты…</p>
    </div>

    <!-- бронь не подтверждена (409 bookingNotConfirmed) или не найдена -->
    <div v-else-if="store.error" class="empty">
      <p class="empty__icon">🎟️</p>
      <p>{{ store.error }}</p>
      <RouterLink to="/bookings" class="btn">К бронированиям</RouterLink>
    </div>

    <div v-else-if="store.tickets.length" class="ticket-list">
      <article
        v-for="ticket in store.tickets"
        :key="ticket.seat"
        class="ticket-card"
      >
        <div
          class="ticket-card__head"
          :style="{
            background: `linear-gradient(140deg, hsl(${ticket.movieHue} 70% 50%), hsl(${ticket.movieHue + 55} 60% 28%))`,
          }"
        >
          <span class="ticket-card__icon">{{ ticket.movieGenreIcon }}</span>
          <div class="ticket-card__head-main">
            <h3 class="ticket-card__title">{{ ticket.movieTitle }}</h3>
            <p class="ticket-card__meta">
              {{ ticket.hall }} · {{ formatSession(ticket.sessionAt) }}
            </p>
          </div>
          <span class="ticket-card__no">{{ ticket.ticketNo }}</span>
        </div>

        <button
          class="ticket-card__qr"
          type="button"
          :aria-label="`QR-код места ${ticket.seat} на весь экран`"
          @click="zoomedSeat = ticket.seat"
        >
          <QrCode :value="ticketQrOf(ticket)" :pixels="220" />
        </button>

        <div class="ticket-card__foot">
          <p class="ticket-card__seat">
            Ряд {{ ticket.seat.split('-')[0] }} ·
            место {{ ticket.seat.split('-')[1] }}
          </p>
          <p class="ticket-card__guest">{{ ticket.customerName }}</p>
        </div>
      </article>
    </div>

    <div v-else class="empty">
      <p class="empty__icon">🍿</p>
      <p>У этой брони нет билетов.</p>
    </div>

    <!-- «у входа в зал»: один QR почти на весь экран телефона -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="zoomedTicket"
          class="ticket-fullscreen"
          tabindex="-1"
          role="dialog"
          aria-modal="true"
          :aria-label="`QR билета на место ${zoomedTicket.seat}`"
          @click.self="closeZoom"
          @keydown.esc="closeZoom"
        >
          <div ref="fullscreenEl" class="ticket-fullscreen__inner" tabindex="-1">
            <QrCode
              class="ticket-fullscreen__qr"
              :value="ticketQrOf(zoomedTicket)"
              :pixels="340"
            />
            <p class="ticket-fullscreen__seat">
              Ряд {{ zoomedTicket.seat.split('-')[0] }} ·
              место {{ zoomedTicket.seat.split('-')[1] }}
            </p>
            <p class="ticket-fullscreen__meta">
              {{ zoomedTicket.movieTitle }} · {{ zoomedTicket.hall }} ·
              {{ formatSession(zoomedTicket.sessionAt) }}
            </p>
            <button class="btn btn--ghost" @click="closeZoom">Закрыть</button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>
