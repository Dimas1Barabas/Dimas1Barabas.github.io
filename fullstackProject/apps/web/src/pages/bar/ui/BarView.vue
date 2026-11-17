<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useBarStore, BAR_STATUS_LABELS } from '@/entities/bar/model/store';
import type { BarOrder, BarOrderStatus } from '@/shared/api/types';

const appStore = useAppStore();
const authStore = useAuthStore();
const movies = useMoviesStore();
const bar = useBarStore();

/** каталог и «мои заказы» — всем; оформление в live — за сессией */
const orderAllowed = computed(() => appStore.mode === 'demo' || authStore.isAuthed);

/** категории витрины в порядке каталога */
const categories = computed(() => {
  const order = ['popcorn', 'drinks', 'snacks', 'combo'] as const;
  const titles: Record<(typeof order)[number], string> = {
    popcorn: 'Попкорн',
    drinks: 'Напитки',
    snacks: 'Снеки',
    combo: 'Комбо',
  };
  return order
    .map((key) => ({
      key,
      title: titles[key],
      items: bar.menu.filter((i) => i.category === key),
    }))
    .filter((c) => c.items.length > 0);
});

/** ближайшие сеансы для подсказки «выдать к сеансу» (если афиша уже есть) */
const sessions = computed(() =>
  movies.movies
    .flatMap((m) =>
      m.sessions.map((s) => ({
        id: s.id,
        label: `${m.title} — ${s.hall}, ${new Date(s.startsAt).toLocaleString('ru-RU', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      })),
    )
    .slice(0, 30),
);

const barSessionId = ref<string | null>(null);
const sessionId = computed({
  get: () => barSessionId.value ?? '',
  set: (v: string) => {
    barSessionId.value = v || null;
  },
});

function qtyOf(itemId: string): number {
  return bar.cart[itemId] ?? 0;
}

function add(item: { id: string; stock: number }): void {
  bar.setQty(item.id, qtyOf(item.id) + 1);
}

function remove(itemId: string): void {
  bar.setQty(itemId, qtyOf(itemId) - 1);
}

function statusClass(status: BarOrderStatus): string {
  return `bar-status_${status.toLowerCase()}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sessionLabel(order: BarOrder): string {
  if (!order.sessionAt || !order.hall) return 'без сеанса — на стойке';
  return `к сеансу ${order.hall}, ${formatTime(order.sessionAt)}`;
}

async function submitOrder(): Promise<void> {
  const ok = await bar.submit(sessionId.value || undefined);
  if (ok) barSessionId.value = null;
}

async function cancelOrder(id: string): Promise<void> {
  await bar.cancel(id);
}

onMounted(() => {
  void bar.refreshMenu();
  void bar.refreshOrders();
  if (movies.movies.length === 0) void movies.load();
  bar.ensureWatching();
});

onUnmounted(() => {
  // поллинг живёт в сторе и переживает страницу, но к чужим экранам
  // тикать незачем; активные заказы вернут его при следующем заходе
  bar.stopWatching();
});
</script>

<template>
  <section class="container bar">
    <h1 class="page-title">Кинобар</h1>
    <p class="bar-pitch">
      Предзаказ попкорна и напитков: оформите сейчас, оплатите на кассе —
      Бармен приготовит к вашему сеансу и напишет, когда ждать на стойке.
    </p>

    <p v-if="bar.error" class="bar-error" data-testid="bar-error">{{ bar.error }}</p>
    <p v-if="bar.notice" class="bar-notice" data-testid="bar-notice">{{ bar.notice }}</p>

    <div v-for="category in categories" :key="category.key" class="bar-category">
      <h2 class="bar-category__title">{{ category.title }}</h2>
      <div class="bar-grid">
        <div
          v-for="item in category.items"
          :key="item.id"
          class="bar-item"
          :class="{ 'bar-item_sold': item.soldOut }"
        >
          <div class="bar-item__head">
            <span class="bar-item__name">{{ item.name }}</span>
            <span class="bar-item__price">{{ item.priceRub }} ₽</span>
          </div>
          <div class="bar-item__foot">
            <span v-if="item.soldOut" class="bar-item__stock bar-item__stock_out">
              продано
            </span>
            <span
              v-else-if="item.stock <= 5"
              class="bar-item__stock bar-item__stock_low"
              data-testid="bar-low-stock"
            >
              осталось {{ item.stock }}
            </span>
            <span v-else class="bar-item__stock">{{ item.stock }} порций</span>

            <span v-if="!orderAllowed || item.soldOut" class="bar-item__qty"></span>
            <span v-else class="bar-item__qty">
              <button
                class="bar-btn"
                type="button"
                :disabled="qtyOf(item.id) === 0"
                :data-testid="`bar-dec-${item.slug}`"
                @click="remove(item.id)"
              >
                −
              </button>
              <span class="bar-item__count" :data-testid="`bar-qty-${item.slug}`">{{
                qtyOf(item.id)
              }}</span>
              <button
                class="bar-btn"
                type="button"
                :disabled="qtyOf(item.id) >= Math.min(item.stock, 10)"
                :data-testid="`bar-inc-${item.slug}`"
                @click="add(item)"
              >
                +
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>

    <p v-if="bar.loadingMenu" class="bar-note">Загружаем каталог…</p>
    <p v-else-if="categories.length === 0" class="bar-note" data-testid="bar-empty">
      Кинобар недоступен — попробуйте позже.
    </p>

    <div v-if="orderAllowed && bar.cartCount > 0" class="bar-cart" data-testid="bar-cart">
      <div class="bar-cart__head">
        <strong>Корзина</strong>
        <span data-testid="bar-cart-total">{{ bar.cartTotal }} ₽</span>
      </div>
      <ul class="bar-cart__lines">
        <li v-for="line in bar.cartLines" :key="line.item.id">
          {{ line.item.name }} × {{ line.qty }} — {{ line.item.priceRub * line.qty }} ₽
        </li>
      </ul>
      <label class="bar-cart__session">
        Выдать к сеансу
        <select v-model="sessionId" data-testid="bar-session">
          <option value="">без сеанса — на стойке</option>
          <option v-for="s in sessions" :key="s.id" :value="s.id">{{ s.label }}</option>
        </select>
      </label>
      <button
        class="btn"
        type="button"
        :disabled="bar.submitting"
        data-testid="bar-submit"
        @click="submitOrder"
      >
        {{ bar.submitting ? 'Оформляем…' : `Оформить предзаказ — ${bar.cartTotal} ₽` }}
      </button>
    </div>

    <template v-if="orderAllowed">
      <h2 class="bar-orders__title">Мои заказы</h2>
      <p v-if="bar.orders.length === 0" class="bar-note" data-testid="bar-orders-empty">
        Пока ничего не заказано.
      </p>
      <ul v-else class="bar-orders">
        <li
          v-for="order in bar.orders"
          :key="order.id"
          class="bar-order"
          :data-testid="`bar-order-${order.status.toLowerCase()}`"
        >
          <div class="bar-order__head">
            <span class="bar-order__id">№{{ order.id.slice(0, 8) }}</span>
            <span class="bar-order__time">{{ formatTime(order.createdAt) }}</span>
            <span class="bar-status" :class="statusClass(order.status)">
              {{ BAR_STATUS_LABELS[order.status] }}
            </span>
          </div>
          <div class="bar-order__items">
            {{ order.items.map((i) => `${i.name}×${i.qty}`).join(', ') }} —
            {{ order.totalRub }} ₽
          </div>
          <div class="bar-order__foot">
            <span class="bar-order__session">{{ sessionLabel(order) }}</span>
            <button
              v-if="order.status === 'NEW' || order.status === 'PREPARING'"
              class="btn btn-ghost"
              type="button"
              :data-testid="`bar-cancel-${order.id}`"
              @click="cancelOrder(order.id)"
            >
              Отменить
            </button>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.bar {
  max-width: 720px;
}

.bar-pitch {
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 0.92rem;
}

.bar-category {
  margin-top: 24px;
}

.bar-category__title {
  font-size: 1.05rem;
  margin: 0 0 10px;
}

.bar-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
}

.bar-item {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}

.bar-item_sold {
  opacity: 0.6;
}

.bar-item__head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.bar-item__name {
  font-weight: 500;
}

.bar-item__price {
  white-space: nowrap;
}

.bar-item__foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.bar-item__stock {
  color: var(--muted);
  font-size: 0.82rem;
}

.bar-item__stock_low {
  color: #fbbf24;
}

.bar-item__stock_out {
  color: var(--muted);
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
}

.bar-item__qty {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.bar-item__count {
  min-width: 1.2em;
  text-align: center;
  font-weight: 600;
}

.bar-btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: inherit;
  font-size: 1rem;
  cursor: pointer;
}

.bar-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.bar-cart {
  margin-top: 28px;
  padding: 16px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: grid;
  gap: 10px;
}

.bar-cart__head {
  display: flex;
  justify-content: space-between;
}

.bar-cart__lines {
  margin: 0;
  padding-left: 18px;
  font-size: 0.9rem;
}

.bar-cart__session {
  display: grid;
  gap: 6px;
  font-size: 0.88rem;
  color: var(--muted);
}

.bar-orders__title {
  font-size: 1.05rem;
  margin: 32px 0 10px;
}

.bar-orders {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}

.bar-order {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: grid;
  gap: 6px;
}

.bar-order__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bar-order__id {
  font-weight: 600;
}

.bar-order__time {
  color: var(--muted);
  font-size: 0.82rem;
}

.bar-status {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.78rem;
  white-space: nowrap;
}

.bar-status_new {
  background: rgba(96, 165, 250, 0.14);
  color: #60a5fa;
}

.bar-status_preparing {
  background: rgba(251, 191, 36, 0.14);
  color: #fbbf24;
}

.bar-status_ready {
  background: rgba(74, 222, 128, 0.16);
  color: #4ade80;
}

.bar-status_picked_up {
  background: rgba(154, 164, 178, 0.14);
  color: var(--muted);
}

.bar-status_cancelled {
  background: rgba(248, 113, 113, 0.12);
  color: #f87171;
  text-decoration: line-through;
}

.bar-order__items {
  font-size: 0.9rem;
}

.bar-order__foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.bar-order__session {
  color: var(--muted);
  font-size: 0.82rem;
}

.bar-note {
  color: var(--muted);
  font-size: 0.9rem;
}

.bar-error {
  margin: 12px 0 0;
  color: #f87171;
  font-size: 0.9rem;
}

.bar-notice {
  margin: 12px 0 0;
  color: #4ade80;
  font-size: 0.9rem;
}

.btn-ghost {
  background: transparent;
}
</style>
