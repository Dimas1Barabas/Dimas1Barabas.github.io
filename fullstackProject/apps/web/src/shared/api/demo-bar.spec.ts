import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { firstSession } from '@/shared/api/demo-spec-helpers';
import type { BarMenuItem } from '@/shared/api/types';

/** id каталога по слагу — читаемее, чем константы-uuid */
function item(slug: string): BarMenuItem {
  const found = demoEngine.barMenu().find((i) => i.slug === slug);
  if (!found) throw new Error(`нет позиции ${slug}`);
  return found;
}

// движок — синглтон на файл: тесты читают остатки живьём (item()) и
// строят ожидания относительно текущего состояния, а не сидов
describe('демо-движок: кинобар', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('каталог отдаёт позиции с остатками, вода — дефицит на виду', () => {
    const menu = demoEngine.barMenu();
    expect(menu.length).toBeGreaterThanOrEqual(9);
    const water = item('water-sparkling');
    expect(water.stock).toBe(3);
    expect(water.soldOut).toBe(false);
  });

  it('заказ: NEW, снимки цен, сумма, подсказка сеанса', () => {
    const { session } = firstSession();
    const popcorn = item('popcorn-salted');
    const cola = item('cola-05');

    const order = demoEngine.createBarOrder({
      items: [
        { itemId: popcorn.id, qty: 2 },
        { itemId: cola.id, qty: 1 },
      ],
      sessionId: session.id,
    });

    expect(order.status).toBe('NEW');
    expect(order.totalRub).toBe(popcorn.priceRub * 2 + cola.priceRub);
    expect(order.items).toHaveLength(2);
    expect(order.hall).toBe(session.hall);
    expect(order.sessionId).toBe(session.id);
    expect(order.items[0].name).toBe('Попкорн солёный');

    // остатки списаны сразу
    expect(item('popcorn-salted').stock).toBe(popcorn.stock - 2);

    // свежие сверху
    expect(demoEngine.myBarOrders()[0].id).toBe(order.id);
  });

  it('Бармен ведёт заказ таймерами: PREPARING → READY → PICKED_UP', () => {
    const cola = item('cola-05');
    const order = demoEngine.createBarOrder({ items: [{ itemId: cola.id, qty: 1 }] });
    const mine = () =>
      demoEngine.myBarOrders().find((o) => o.id === order.id)!;

    vi.advanceTimersByTime(4_000);
    expect(mine().status).toBe('PREPARING');
    vi.advanceTimersByTime(4_000);
    expect(mine().status).toBe('READY');
    vi.advanceTimersByTime(4_000);
    expect(mine().status).toBe('PICKED_UP');
  });

  it('нехватка остатка — 409 с честным сообщением, ничего не списано', () => {
    const water = item('water-sparkling'); // 3 порции
    const nachos = item('nachos-cheese');
    const ordersBefore = demoEngine.myBarOrders().length;

    const call = () =>
      demoEngine.createBarOrder({
        items: [
          { itemId: nachos.id, qty: 1 },
          { itemId: water.id, qty: 5 },
        ],
      });
    expect(call).toThrow(ApiError);
    try {
      call();
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).body).toContain('Вода газированная 0,5 л');
      expect((err as ApiError).body).toContain('осталось 3 порц.');
    }
    // откат «транзакции»: начос не списан, новых заказов нет
    expect(item('nachos-cheese').stock).toBe(nachos.stock);
    expect(demoEngine.myBarOrders()).toHaveLength(ordersBefore);
  });

  it('отмена NEW возвращает порции на склад и гасит Бармена', () => {
    const water = item('water-sparkling');
    const order = demoEngine.createBarOrder({ items: [{ itemId: water.id, qty: 3 }] });
    expect(item('water-sparkling').stock).toBe(0);
    expect(item('water-sparkling').soldOut).toBe(true);

    const cancelled = demoEngine.cancelBarOrder(order.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(item('water-sparkling').stock).toBe(3);
    expect(item('water-sparkling').soldOut).toBe(false);

    // таймеры отменённого заказа больше ничего не двигают
    vi.advanceTimersByTime(20_000);
    const mine = demoEngine.myBarOrders().find((o) => o.id === order.id)!;
    expect(mine.status).toBe('CANCELLED');
  });

  it('отмена выданного — 409, повторная — 409', () => {
    const cola = item('cola-05');
    const order = demoEngine.createBarOrder({ items: [{ itemId: cola.id, qty: 1 }] });
    vi.advanceTimersByTime(12_000); // PICKED_UP
    expect(() => demoEngine.cancelBarOrder(order.id)).toThrow(ApiError);

    const cancelled = demoEngine.createBarOrder({ items: [{ itemId: cola.id, qty: 1 }] });
    demoEngine.cancelBarOrder(cancelled.id);
    expect(() => demoEngine.cancelBarOrder(cancelled.id)).toThrow(ApiError);
  });

  it('валидация: пустая корзина и дубль позиции — 400', () => {
    const cola = item('cola-05');
    expect(() => demoEngine.createBarOrder({ items: [] })).toThrow(ApiError);
    expect(() =>
      demoEngine.createBarOrder({
        items: [
          { itemId: cola.id, qty: 1 },
          { itemId: cola.id, qty: 2 },
        ],
      }),
    ).toThrow(ApiError);
  });

  it('несуществующий сеанс — 404', () => {
    const cola = item('cola-05');
    expect(() =>
      demoEngine.createBarOrder({
        items: [{ itemId: cola.id, qty: 1 }],
        sessionId: 'нет-такого-сеанса',
      }),
    ).toThrow(ApiError);
  });
});
