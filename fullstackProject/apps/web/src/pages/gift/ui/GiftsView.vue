<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useGiftStore } from '@/entities/gift/model/store';
import {
  GIFT_NOMINAL_MAX,
  GIFT_NOMINAL_MIN,
  GIFT_NOMINAL_STEP,
} from '@/shared/lib/gift';

const appStore = useAppStore();
const authStore = useAuthStore();
const gifts = useGiftStore();

/** демо показывает витрину всем; live — только владельцу сессии */
const allowed = computed(() => appStore.mode === 'demo' || authStore.isAuthed);

/** пресеты номиналов — кнопки вместо поля ввода */
const PRESETS = [500, 1000, 2000, 5000];

const nominal = ref<number>(PRESETS[1]);
const purchasing = ref(false);
const purchaseError = ref('');

const activateCode = ref('');
const activating = ref(false);
const activateError = ref('');
const activatedCode = ref('');

const copied = ref(false);

const lastCode = computed(() =>
  gifts.last ? gifts.last.code : activatedCode.value,
);

async function purchase(): Promise<void> {
  purchaseError.value = '';
  purchasing.value = true;
  try {
    await gifts.purchase(nominal.value);
  } catch (err) {
    purchaseError.value = messageOf(err, 'Не удалось купить сертификат');
  } finally {
    purchasing.value = false;
  }
}

async function activate(): Promise<void> {
  activateError.value = '';
  activatedCode.value = '';
  activating.value = true;
  try {
    const gift = await gifts.activate(activateCode.value);
    activatedCode.value = gift.code;
    activateCode.value = '';
  } catch (err) {
    activateError.value = messageOf(err, 'Не удалось активировать код');
  } finally {
    activating.value = false;
  }
}

async function copyCode(): Promise<void> {
  copied.value = false;
  if (!lastCode.value) return;
  try {
    await navigator.clipboard.writeText(lastCode.value);
    copied.value = true;
  } catch {
    // буфер недоступен — код крупно на экране, копируем вручную
  }
}

function messageOf(err: unknown, fallback: string): string {
  const message = (err as { message?: string })?.message ?? '';
  try {
    const parsed = JSON.parse(message) as { message?: string };
    if (parsed.message) return parsed.message;
  } catch {
    // не JSON — отдаём как есть
  }
  return message || fallback;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU');
}

/** живая карта: остаток больше нуля и срок не вышел */
function isLive(code: string): boolean {
  const card = gifts.account?.cards.find((c) => c.code === code);
  if (!card) return false;
  return card.status === 'active' && Date.parse(card.expiresAt) > Date.now();
}

onMounted(() => {
  if (allowed.value) void gifts.refresh();
});
</script>

<template>
  <section class="container gifts">
    <h1 class="page-title">Подарочные сертификаты</h1>

    <template v-if="!allowed">
      <p class="auth-note">
        Сертификаты видны только владельцу сессии — войдите, чтобы купить
        карту или активировать подаренный код.
      </p>
      <RouterLink class="btn" to="/login">Войти</RouterLink>
    </template>

    <template v-else>
      <p class="gifts-pitch">
        Подарите кино: карта номиналом от {{ GIFT_NOMINAL_MIN }} до
        {{ GIFT_NOMINAL_MAX }} ₽ живёт год, тратится частями и закрывает
        любой чек броней — целиком или хвост после промокода и бонусов.
      </p>

      <!-- свежая покупка: код крупно, чтобы передать получателю -->
      <div v-if="lastCode" class="gifts-box gifts-fresh" data-testid="gift-fresh">
        <span class="gifts-fresh__label">Код карты — передайте его получателю</span>
        <code class="gifts-fresh__code" data-testid="gift-fresh-code">{{
          lastCode
        }}</code>
        <button class="btn" type="button" data-testid="gift-copy" @click="copyCode">
          {{ copied ? 'Скопировано ✓' : 'Скопировать код' }}
        </button>
      </div>

      <div class="gifts-grid">
        <div class="gifts-box gifts-buy">
          <h2 class="gifts-subtitle">Купить сертификат</h2>
          <div class="gifts-presets">
            <button
              v-for="preset in PRESETS"
              :key="preset"
              class="gifts-preset"
              :class="{ 'gifts-preset_on': nominal === preset }"
              type="button"
              :data-testid="`gift-nominal-${preset}`"
              @click="nominal = preset"
            >
              {{ preset.toLocaleString('ru-RU') }} ₽
            </button>
          </div>
          <p class="gifts-hint">
            Номинал — круглая сумма, кратная {{ GIFT_NOMINAL_STEP }} ₽;
            срок действия 365 дней.
          </p>
          <button
            class="btn"
            type="button"
            :disabled="purchasing"
            data-testid="gift-buy"
            @click="purchase"
          >
            {{ purchasing ? 'Оформляем…' : `Купить за ${nominal.toLocaleString('ru-RU')} ₽` }}
          </button>
          <p v-if="purchaseError" class="gifts-error" data-testid="gift-buy-error">
            {{ purchaseError }}
          </p>
        </div>

        <div class="gifts-box gifts-activate">
          <h2 class="gifts-subtitle">Активировать подаренный код</h2>
          <form
            class="gifts-form"
            @submit.prevent="activate"
          >
            <input
              v-model="activateCode"
              class="gifts-input"
              placeholder="GIFT-XXXXXXXX"
              data-testid="gift-activate-input"
              autocomplete="off"
            />
            <button
              class="btn"
              type="submit"
              :disabled="activating || activateCode.trim().length < 5"
              data-testid="gift-activate"
            >
              {{ activating ? 'Активируем…' : 'Активировать' }}
            </button>
          </form>
          <p v-if="activateError" class="gifts-error" data-testid="gift-activate-error">
            {{ activateError }}
          </p>
          <p v-else-if="activatedCode" class="gifts-ok" data-testid="gift-activated-ok">
            Карта {{ activatedCode }} активирована — остаток виден ниже.
          </p>
        </div>
      </div>

      <template v-if="gifts.account">
        <div class="gifts-totals">
          <div class="gifts-box gifts-total">
            <span class="gifts-total__value">{{ gifts.account.totals.availableRub }} ₽</span>
            <span class="gifts-total__label">доступно картами</span>
          </div>
          <div class="gifts-box gifts-total">
            <span class="gifts-total__value">{{ gifts.account.totals.cards }}</span>
            <span class="gifts-total__label">мои карты</span>
          </div>
          <div class="gifts-box gifts-total">
            <span class="gifts-total__value">{{ gifts.account.totals.given }}</span>
            <span class="gifts-total__label">подарены, ждут кода</span>
          </div>
        </div>

        <h2 class="gifts-subtitle">Мои карты</h2>
        <table v-if="gifts.account.cards.length" class="gifts-table">
          <thead>
            <tr>
              <th>Код</th>
              <th>Номинал</th>
              <th>Остаток</th>
              <th>Действует до</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="card in gifts.account.cards"
              :key="card.id"
              :data-testid="`gift-card-${card.code}`"
            >
              <td><code>{{ card.code }}</code></td>
              <td>{{ card.nominalRub.toLocaleString('ru-RU') }} ₽</td>
              <td>
                <span
                  v-if="isLive(card.code)"
                  class="gifts-badge gifts-badge_live"
                >
                  {{ card.remainingRub.toLocaleString('ru-RU') }} ₽
                </span>
                <span v-else class="gifts-badge gifts-badge_off">
                  {{ card.status === 'exhausted' ? 'потрачена' : 'истекла' }}
                </span>
              </td>
              <td>{{ formatDate(card.expiresAt) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="auth-note">
          Активных карт нет: введите подаренный код выше или купите карту
          себе — код активируется той же кнопкой.
        </p>

        <template v-if="gifts.account.given.length">
          <h2 class="gifts-subtitle">Подаренные коды</h2>
          <table class="gifts-table">
            <thead>
              <tr>
                <th>Код</th>
                <th>Номинал</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="card in gifts.account.given" :key="card.id">
                <td><code>{{ card.code }}</code></td>
                <td>{{ card.nominalRub.toLocaleString('ru-RU') }} ₽</td>
                <td>
                  <span class="gifts-badge gifts-badge_wait">ждёт получателя</span>
                </td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
      <p v-else class="auth-note">Загружаем ваши сертификаты…</p>
    </template>
  </section>
</template>

<style scoped>
.gifts {
  max-width: 720px;
}

.gifts-pitch {
  margin: 12px 0 0;
}

.gifts-box {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}

.gifts-fresh {
  display: grid;
  gap: 10px;
  margin-top: 16px;
  justify-items: start;
}

.gifts-fresh__label {
  color: var(--muted);
  font-size: 0.85rem;
}

.gifts-fresh__code {
  font-size: 1.5rem;
  letter-spacing: 0.2em;
  font-weight: 600;
}

.gifts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 16px;
}

.gifts-subtitle {
  font-size: 1.05rem;
  margin: 0 0 12px;
}

.gifts-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.gifts-preset {
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.gifts-preset_on {
  border-color: var(--accent, #7aa2f7);
  background: rgba(122, 162, 247, 0.14);
  font-weight: 600;
}

.gifts-hint {
  color: var(--muted);
  font-size: 0.82rem;
  margin: 0 0 12px;
}

.gifts-form {
  display: flex;
  gap: 8px;
}

.gifts-input {
  flex: 1;
  min-width: 0;
}

.gifts-error {
  color: #f87171;
  font-size: 0.85rem;
  margin: 10px 0 0;
}

.gifts-ok {
  color: #4ade80;
  font-size: 0.85rem;
  margin: 10px 0 0;
}

.gifts-totals {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-top: 20px;
}

.gifts-total {
  display: grid;
  gap: 4px;
  justify-items: center;
}

.gifts-total__value {
  font-size: 1.3rem;
  font-weight: 600;
}

.gifts-total__label {
  color: var(--muted);
  font-size: 0.8rem;
  text-align: center;
}

.gifts-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
  font-size: 0.92rem;
}

.gifts-table th,
.gifts-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.gifts-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  white-space: nowrap;
}

.gifts-badge_live {
  background: rgba(74, 222, 128, 0.14);
  color: #4ade80;
}

.gifts-badge_off {
  background: rgba(154, 164, 178, 0.14);
  color: var(--muted);
}

.gifts-badge_wait {
  background: rgba(250, 204, 21, 0.14);
  color: #facc15;
}

.auth-note {
  color: var(--muted);
  font-size: 0.9rem;
  margin: 8px 0 0;
}

@media (max-width: 640px) {
  .gifts-grid,
  .gifts-totals {
    grid-template-columns: 1fr;
  }
}
</style>
