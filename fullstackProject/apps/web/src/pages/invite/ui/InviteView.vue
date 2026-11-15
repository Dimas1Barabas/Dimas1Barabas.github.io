<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useReferralStore } from '@/entities/referral/model/store';
import { inviteLink } from '@/shared/lib/referral';

const appStore = useAppStore();
const authStore = useAuthStore();
const referral = useReferralStore();

/** демо показывает витрину всем; live — только владельцу сессии */
const allowed = computed(() => appStore.mode === 'demo' || authStore.isAuthed);

const copied = ref(false);
const copyFailed = ref(false);

const link = computed(() =>
  referral.account ? inviteLink(location.origin + location.pathname, referral.account.code) : '',
);

async function copyLink(): Promise<void> {
  copied.value = false;
  copyFailed.value = false;
  try {
    await navigator.clipboard.writeText(link.value);
    copied.value = true;
  } catch {
    // clipboard API нет (небезопасный контекст) — ссылка выделена,
    // копируем вручную; в тестовой сборке тоже идём сюда не всегда
    copyFailed.value = true;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU');
}

onMounted(() => {
  if (allowed.value) void referral.refresh();
});
</script>

<template>
  <section class="container invite">
    <h1 class="page-title">Пригласить друга</h1>

    <template v-if="!allowed">
      <p class="auth-note">
        Реферальный счёт виден только владельцу сессии — войдите, чтобы
        получить код приглашения.
      </p>
      <RouterLink class="btn" to="/login">Войти</RouterLink>
    </template>

    <template v-else-if="referral.account">
      <p class="invite-pitch">
        Друг регистрируется по вашей ссылке и получает
        <strong>+{{ referral.account.bonusFriend }} бонусов</strong> к первой
        оплате, вы — <strong>+{{ referral.account.bonusInviter }}</strong>.
        1 бонус = 1 ₽.
      </p>

      <div class="invite-code invite-box">
        <span class="invite-code__label">Ваш код</span>
        <code class="invite-code__value" data-testid="referral-code">{{
          referral.account.code
        }}</code>
        <button class="btn" type="button" data-testid="copy-link" @click="copyLink">
          {{ copied ? 'Скопировано ✓' : 'Скопировать ссылку' }}
        </button>
        <p v-if="copyFailed" class="invite-link-hint" data-testid="copy-hint">
          Буфер обмена недоступен — скопируйте вручную:
          <input class="invite-link-input" readonly :value="link" />
        </p>
      </div>

      <div class="invite-totals">
        <div class="invite-box invite-total">
          <span class="invite-total__value">{{ referral.account.totals.invited }}</span>
          <span class="invite-total__label">приглашено</span>
        </div>
        <div class="invite-box invite-total">
          <span class="invite-total__value">{{ referral.account.totals.paid }}</span>
          <span class="invite-total__label">оплатили первую бронь</span>
        </div>
        <div class="invite-box invite-total" data-testid="total-earned">
          <span class="invite-total__value">+{{ referral.account.totals.earned }}</span>
          <span class="invite-total__label">бонусов заработано</span>
        </div>
      </div>

      <h2 class="invite-subtitle">Кто пришёл по коду</h2>
      <table v-if="referral.account.invited.length" class="invite-table">
        <thead>
          <tr>
            <th>Друг</th>
            <th>Регистрация</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="friend in referral.account.invited"
            :key="friend.email + friend.registeredAt"
          >
            <td>
              <span class="invite-friend__name">{{ friend.name }}</span>
              <span class="invite-friend__email">{{ friend.email }}</span>
            </td>
            <td>{{ formatDate(friend.registeredAt) }}</td>
            <td>
              <span
                class="invite-badge"
                :class="friend.paid ? 'invite-badge_paid' : 'invite-badge_wait'"
              >
                {{ friend.paid ? 'оплатил ✓' : 'ещё не оплатил' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="auth-note">
        Пока никого: отправьте ссылку друзьям — бонус упадёт после их первой
        оплаченной брони.
      </p>
    </template>

    <p v-else class="auth-note">Загружаем реферальный счёт…</p>
  </section>
</template>

<style scoped>
.invite {
  max-width: 640px;
}

.invite-pitch {
  margin: 12px 0 0;
}

.invite-box {
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.invite-code {
  display: grid;
  gap: 10px;
  margin-top: 16px;
  padding: 18px;
  justify-items: start;
}

.invite-code__label {
  color: var(--muted);
  font-size: 0.85rem;
}

.invite-code__value {
  font-size: 1.6rem;
  letter-spacing: 0.35em;
  font-weight: 600;
}

.invite-totals {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-top: 16px;
}

.invite-total {
  display: grid;
  gap: 4px;
  padding: 14px;
  justify-items: center;
}

.invite-total__value {
  font-size: 1.4rem;
  font-weight: 600;
}

.invite-total__label {
  color: var(--muted);
  font-size: 0.82rem;
  text-align: center;
}

.invite-subtitle {
  font-size: 1.05rem;
  margin: 28px 0 0;
}

.invite-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
  font-size: 0.92rem;
}

.invite-table th,
.invite-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.invite-friend__name,
.invite-friend__email {
  display: block;
}

.invite-friend__email {
  color: var(--muted);
  font-size: 0.82rem;
}

.invite-badge {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  white-space: nowrap;
}

.invite-badge_paid {
  background: rgba(74, 222, 128, 0.14);
  color: #4ade80;
}

.invite-badge_wait {
  background: rgba(154, 164, 178, 0.14);
  color: var(--muted);
}

.invite-link-hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
  max-width: 100%;
}

.invite-link-input {
  width: 100%;
  margin-top: 6px;
  font-size: 0.8rem;
}

@media (max-width: 560px) {
  .invite-totals {
    grid-template-columns: 1fr;
  }
}

.auth-note {
  color: var(--muted);
  font-size: 0.9rem;
  margin: 8px 0 0;
}
</style>
