import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { ApiError, api, storedUser } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { BarMenuItem, BarOrder, BarOrderStatus } from '@/shared/api/types';

/** статусы, в которых заказ ещё жив — поллинг/отмена имеют смысл */
const ACTIVE: readonly BarOrderStatus[] = ['NEW', 'PREPARING', 'READY'];

/** порций одной позиции — потолок и API, и витрины */
export const MAX_QTY_PER_ITEM = 10;

/** частота опроса «моих заказов» в live: Бармен жмёт кнопки руками */
const POLL_MS = 5_000;

/** человекочитаемый текст ошибки: у ApiError сообщение — в JSON-теле */
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { message?: unknown };
      if (typeof body.message === 'string') return body.message;
    } catch {
      /* тело не JSON — остаётся err.message */
    }
  }
  return err instanceof Error ? err.message : 'Ошибка загрузки';
}

/** подпись статуса для витрины: что происходит с заказом */
export const BAR_STATUS_LABELS: Record<BarOrderStatus, string> = {
  NEW: 'оформлен',
  PREPARING: 'Бармен готовит',
  READY: 'ждём на стойке бара',
  PICKED_UP: 'выдан',
  CANCELLED: 'отменён',
};

/**
 * Кинобар: каталог с остатками, корзина и «мои заказы». Live — REST за
 * JWT (остатки списывает API, статусы пригоняет Бармен событиями); демо
 * — зеркальная логика движка (таймеры играют Бармена). Пока есть
 * активные заказы, live опрашивает /bar/orders/my, демо слушает onChange.
 */
export const useBarStore = defineStore('bar', {
  state: () => ({
    menu: [] as BarMenuItem[],
    orders: [] as BarOrder[],
    /** корзина: itemId → порции */
    cart: {} as Record<string, number>,
    loadingMenu: false,
    submitting: false,
    error: null as string | null,
    notice: null as string | null,
    pollTimer: null as ReturnType<typeof setInterval> | null,
    unsubscribe: null as (() => void) | null,
  }),

  getters: {
    /** строки корзины поверх каталога: позиция + количество */
    cartLines(state): { item: BarMenuItem; qty: number }[] {
      return state.menu
        .filter((item) => (state.cart[item.id] ?? 0) > 0)
        .map((item) => ({ item, qty: state.cart[item.id] }));
    },
    cartTotal(): number {
      return this.cartLines.reduce((s, l) => s + l.item.priceRub * l.qty, 0);
    },
    cartCount(): number {
      return this.cartLines.reduce((s, l) => s + l.qty, 0);
    },
    /** живые заказы: ради них крутится поллинг */
    activeOrders(state): BarOrder[] {
      return state.orders.filter((o) => ACTIVE.includes(o.status));
    },
  },

  actions: {
    async refreshMenu(): Promise<void> {
      const app = useAppStore();
      this.loadingMenu = true;
      try {
        this.menu =
          app.mode === 'demo' ? demoEngine.barMenu() : await api.barMenu();
      } catch {
        this.menu = []; // витрина покажет «кинобар недоступен»
      } finally {
        this.loadingMenu = false;
      }
    },

    async refreshOrders(): Promise<void> {
      const app = useAppStore();
      try {
        if (app.mode === 'demo') {
          this.orders = demoEngine.myBarOrders();
        } else if (storedUser()) {
          this.orders = await api.myBarOrders();
        } else {
          this.orders = []; // live без сессии — заказов нет
        }
      } catch {
        // заказы не критичны для витрины каталога — молча оставляем старые
      }
    },

    /** порции позиции в корзине: 0 убирает, потолок — остаток и 10 */
    setQty(itemId: string, qty: number): void {
      const item = this.menu.find((i) => i.id === itemId);
      if (!item) return;
      const capped = Math.max(0, Math.min(Math.floor(qty), item.stock, MAX_QTY_PER_ITEM));
      if (capped === 0) delete this.cart[itemId];
      else this.cart[itemId] = capped;
    },

    clearCart(): void {
      this.cart = {};
    },

    /** оформить заказ; false — API отказал (остаток уже уехал) */
    async submit(sessionId?: string): Promise<boolean> {
      const lines = Object.entries(this.cart).map(([itemId, qty]) => ({ itemId, qty }));
      if (lines.length === 0) {
        this.error = 'Корзина пуста';
        return false;
      }
      this.error = null;
      this.notice = null;
      this.submitting = true;
      try {
        const app = useAppStore();
        const payload = sessionId
          ? { items: lines, sessionId }
          : { items: lines };
        const order =
          app.mode === 'demo'
            ? demoEngine.createBarOrder(payload)
            : await api.createBarOrder(payload);
        this.notice = `Заказ №${order.id.slice(0, 8)} оформлен — ${BAR_STATUS_LABELS.NEW}`;
        this.clearCart();
        await Promise.all([this.refreshMenu(), this.refreshOrders()]);
        this.ensureWatching();
        return true;
      } catch (err) {
        // 409 с честным остатком и прочие отказы — текстом; меню могло
        // устареть — перезагружаем, чтобы бейджи сошлись
        this.error = errorText(err);
        void this.refreshMenu();
        return false;
      } finally {
        this.submitting = false;
      }
    },

    /** отменить заказ NEW/PREPARING; false — уже выдан/отменён */
    async cancel(orderId: string): Promise<boolean> {
      this.error = null;
      try {
        const app = useAppStore();
        if (app.mode === 'demo') demoEngine.cancelBarOrder(orderId);
        else await api.cancelBarOrder(orderId);
        await Promise.all([this.refreshMenu(), this.refreshOrders()]);
        return true;
      } catch (err) {
        this.error = errorText(err);
        return false;
      }
    },

    /** поллинг/подписка: живёт, пока есть активные заказы */
    ensureWatching(): void {
      if (this.activeOrders.length === 0) {
        this.stopWatching();
        return;
      }
      const app = useAppStore();
      if (app.mode === 'demo') {
        if (!this.unsubscribe) {
          // движок не реактивен: таймеры Бармена двигают заказы — слушаем
          // и после каждого изменения перепроверяем, есть ли ещё активные
          this.unsubscribe = demoEngine.onChange(() => {
            void this.refreshOrders().then(() => this.ensureWatching());
          });
        }
        return;
      }
      if (this.pollTimer) return;
      this.pollTimer = setInterval(() => {
        void this.refreshOrders();
        if (this.activeOrders.length === 0) this.stopWatching();
      }, POLL_MS);
    },

    stopWatching(): void {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    },
  },
});
