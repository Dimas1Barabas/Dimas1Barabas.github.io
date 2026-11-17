import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { useBarStore } from '@/entities/bar/model/store';
import { demoEngine } from '@/shared/api/demo-engine';
import { firstSession } from '@/shared/api/demo-spec-helpers';
import type { BarMenuItem } from '@/shared/api/types';

/**
 * Стор кинобара на демо-режиме: корзина с потолками, оформление со
 * списанием, ошибка нехватки из движка, отмена с возвратом и подписка
 * на таймеры Бармена.
 */

function item(slug: string): BarMenuItem {
  const found = demoEngine.barMenu().find((i) => i.slug === slug);
  if (!found) throw new Error(`нет позиции ${slug}`);
  return found;
}

describe('useBarStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useAppStore().mode = 'demo';
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it('корзина: +/− считают порции, потолок — остаток и 10, 0 убирает', async () => {
    const bar = useBarStore();
    await bar.refreshMenu();
    const water = item('water-sparkling'); // stock 3

    bar.setQty(water.id, 1);
    bar.setQty(water.id, 99); // потолок — stock
    expect(bar.cart[water.id]).toBe(3);

    const combo = item('combo-family'); // stock 8 — ниже MAX_QTY
    bar.setQty(combo.id, 50);
    expect(bar.cart[combo.id]).toBe(8);

    bar.setQty(water.id, 0);
    expect(bar.cart[water.id]).toBeUndefined();
    expect(bar.cartLines.map((l) => l.item.slug)).toEqual(['combo-family']);
    expect(bar.cartTotal).toBe(combo.priceRub * 8);
    expect(bar.cartCount).toBe(8);
  });

  it('оформление: заказ уходит, корзина чистится, статус NEW', async () => {
    const bar = useBarStore();
    await bar.refreshMenu();
    const cola = item('cola-05');
    const { session } = firstSession();

    bar.setQty(cola.id, 2);
    const ok = await bar.submit(session.id);
    expect(ok).toBe(true);
    expect(bar.cartCount).toBe(0);
    expect(bar.notice).toContain('оформлен');
    expect(bar.orders).toHaveLength(1);
    expect(bar.orders[0].status).toBe('NEW');
    expect(bar.orders[0].hall).toBe(session.hall);
    // остаток в меню обновился
    expect(bar.menu.find((i) => i.id === cola.id)!.stock).toBe(cola.stock - 2);
    bar.stopWatching();
  });

  it('нехватка остатка: ошибка текстом из движка, корзина цела', async () => {
    const bar = useBarStore();
    await bar.refreshMenu();
    const water = item('water-sparkling'); // 3

    // гонка «витрина устарела»: кто-то забрал остаток напрямую, а меню
    // ещё показывает 3 порции — API откажет честным 409 с остатком
    demoEngine.createBarOrder({ items: [{ itemId: water.id, qty: 3 }] });

    bar.setQty(water.id, 2); // потолок по устаревшему меню
    expect(await bar.submit()).toBe(false);
    expect(bar.error).toContain('Вода газированная 0,5 л');
    expect(bar.cartCount).toBe(2); // корзина не чистится при отказе
    // после отказа меню перезагружено — дефицит виден витрине
    expect(bar.menu.find((i) => i.id === water.id)!.stock).toBe(0);
  });

  it('отмена: NEW → CANCELLED, порции вернулись', async () => {
    const bar = useBarStore();
    await bar.refreshMenu();
    const nachos = item('nachos-cheese');

    bar.setQty(nachos.id, 2);
    await bar.submit();
    const orderId = bar.orders[0].id;
    bar.stopWatching();

    expect(await bar.cancel(orderId)).toBe(true);
    expect(bar.orders[0].status).toBe('CANCELLED');
    expect(bar.menu.find((i) => i.id === nachos.id)!.stock).toBe(nachos.stock);
  });

  it('watch: демо слушает onChange, статус доехал после таймеров', async () => {
    const bar = useBarStore();
    await bar.refreshMenu();
    const cola = item('cola-05');
    bar.setQty(cola.id, 1);
    await bar.submit();
    expect(bar.unsubscribe).not.toBeNull(); // подписка активна

    const mine = () => bar.orders.find((o) => o.items[0]?.itemId === cola.id)!;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mine().status).toBe('PREPARING');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mine().status).toBe('READY');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mine().status).toBe('PICKED_UP');

    // ручная остановка гасит подписку (unmount страницы)
    bar.stopWatching();
    expect(bar.unsubscribe).toBeNull();
    expect(bar.pollTimer).toBeNull();
  });
});
