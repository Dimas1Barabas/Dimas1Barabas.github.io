/**
 * Fraud-стор (unit): демо-режим — витрина решений движка и резолвы.
 * Очередь, фильтр и ошибки — паттерн этапа 36; хелперы сидов — общие
 * (demo-spec-helpers), движок живой, без сети.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import { freeSeat, firstSession } from '@/shared/api/demo-spec-helpers';
import { useFraudStore } from './store';

/** разгон до review: пять броней до чекаута (срез видит их до создания) */
function rampToReview(sessionId: string): string {
  for (let i = 0; i < 5; i++) {
    demoEngine.create({
      sessionId,
      seats: [freeSeat(demoEngine.seatMap(sessionId))],
    });
  }
  const booking = demoEngine.checkout({
    sessionId,
    seats: [freeSeat(demoEngine.seatMap(sessionId))],
  });
  expect(booking.fraudHold).toBe(true);
  return booking.id;
}

describe('useFraudStore (демо-режим)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    demoEngine.reset();
    useAppStore().mode = 'demo';
    vi.restoreAllMocks();
  });

  it('refresh: решения движка, счётчик очереди живой', async () => {
    const { session } = firstSession();
    const bookingId = rampToReview(session.id);
    const store = useFraudStore();

    await store.refresh();

    expect(store.decisions.length).toBeGreaterThan(0);
    expect(store.pendingCount).toBe(1);
    expect(
      store.decisions.find((d) => d.bookingId === bookingId)?.status,
    ).toBe('pending_review');
  });

  it('resolve approve: очередь пустеет, решение — approved', async () => {
    const { session } = firstSession();
    const bookingId = rampToReview(session.id);
    const store = useFraudStore();
    await store.refresh();

    await store.resolve(bookingId, 'approve');

    expect(store.pendingCount).toBe(0);
    expect(store.lastResolved).toMatchObject({
      bookingId,
      resolved: 'approved',
      status: 'PENDING', // системная оплата запущена
    });
    expect(
      store.decisions.find((d) => d.bookingId === bookingId)?.status,
    ).toBe('approved');
  });

  it('повторный резолв — ошибка «уже принято», список не ломается', async () => {
    const { session } = firstSession();
    const bookingId = rampToReview(session.id);
    const store = useFraudStore();
    await store.refresh();
    await store.resolve(bookingId, 'reject');

    await store.resolve(bookingId, 'approve'); // второй админ опоздал

    expect(store.error).toBeTruthy();
    expect(
      store.decisions.find((d) => d.bookingId === bookingId)?.status,
    ).toBe('rejected');
  });
});
