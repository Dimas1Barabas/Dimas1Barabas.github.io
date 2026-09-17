<script setup lang="ts">
import type { BookingStatus } from '@/shared/api/types';

defineProps<{ status: BookingStatus }>();

const labels: Record<BookingStatus, string> = {
  PENDING_PAYMENT: '💳 ждёт оплаты',
  PENDING: '⏳ оплата проводится',
  CONFIRMED: '✅ подтверждена',
  FAILED: '✖ отказ',
  EXPIRED: '⌛ истекла',
  CANCELLING: '↩️ идёт возврат',
  CANCELLED: '🚫 отменена',
};
</script>

<template>
  <span class="status-badge" :class="`status-badge--${status.toLowerCase()}`">
    {{ labels[status] }}
  </span>
</template>
