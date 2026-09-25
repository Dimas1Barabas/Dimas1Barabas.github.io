<script setup lang="ts">
import type { ReminderStreamEvent } from '@/shared/api/types';
import { formatSeats, formatSession } from '@/shared/lib/format';

/** письмо «скоро сеанс» как баннер: та же нора, что у waitlist-всплывашки */
defineProps<{
  event: ReminderStreamEvent;
}>();

const emit = defineEmits<{
  dismiss: [];
}>();
</script>

<template>
  <div class="waitlist-banner" role="status">
    <span class="waitlist-banner__icon" aria-hidden="true">⏰</span>
    <p class="waitlist-banner__text">
      Скоро сеанс:
      <strong>{{ event.movieTitle }}</strong>,
      {{ event.hall }},
      {{ formatSession(event.sessionAt) }} — ваши места {{ formatSeats(event.seats) }}
    </p>
    <div class="waitlist-banner__actions">
      <RouterLink
        class="btn btn--sm"
        :to="`/ticket/${event.bookingId}`"
        @click="emit('dismiss')"
      >
        Показать QR
      </RouterLink>
      <button
        class="btn btn--ghost btn--sm"
        type="button"
        @click="emit('dismiss')"
      >
        Позже
      </button>
    </div>
  </div>
</template>
