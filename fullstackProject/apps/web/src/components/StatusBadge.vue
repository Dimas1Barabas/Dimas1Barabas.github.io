<script setup lang="ts">
import type { BookingStatus } from '../api/types';

defineProps<{ status: BookingStatus }>();

const labels: Record<BookingStatus, string> = {
  PENDING: '⏳ в обработке',
  CONFIRMED: '✅ подтверждена',
  FAILED: '✖ отказ',
  CANCELLING: '↩️ идёт возврат',
  CANCELLED: '🚫 отменена',
};
</script>

<template>
  <span class="status-badge" :class="`status-badge--${status.toLowerCase()}`">
    {{ labels[status] }}
  </span>
</template>
