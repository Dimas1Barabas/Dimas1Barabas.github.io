<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, retryAfterFrom } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useCooldown } from '@/shared/lib/use-cooldown';

const router = useRouter();
const route = useRoute();
const appStore = useAppStore();
const authStore = useAuthStore();

const mode = ref<'login' | 'register'>('login');
const email = ref('');
const password = ref('');
const name = ref('');
/** код пригласившего из ссылки ?ref= — виден и редактируем в регистрации */
const refCode = ref(
  typeof route.query.ref === 'string' ? route.query.ref.trim() : '',
);
const submitting = ref(false);
const error = ref<string | null>(null);
/** кулдаун после 429 Привратника: корзина входа (5/мин на email) пуста */
const { cooldownSec, startCooldown } = useCooldown();

/** второй шаг 2FA: пароль верен, ждём код приложения или backup */
const secondFactor = ref<string | null>(null); // билет
const otpCode = ref('');
const trustDevice = ref(true);
const deviceName = ref('');

/** 401/409 у API несут человекочитаемый message — показываем его */
function apiMessage(err: unknown): string | null {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { message?: string | string[] };
      if (typeof body.message === 'string') return body.message;
    } catch {
      /* не JSON — общий текст ниже */
    }
  }
  return null;
}

/** демо без телефона: текущий код подсказывает движок, как «письма» */
const demoHint = ref<string | null>(null);

async function submit(): Promise<void> {
  if (submitting.value || cooldownSec.value > 0) return;
  submitting.value = true;
  error.value = null;
  try {
    if (mode.value === 'login') {
      const outcome = await authStore.login(email.value.trim(), password.value);
      if (outcome && 'twoFactorRequired' in outcome) {
        secondFactor.value = outcome.ticket;
        otpCode.value = '';
        demoHint.value =
          appStore.mode === 'demo' ? demoEngine.demoTotpHint() : null;
        return;
      }
    } else {
      // после регистрации сразу входим — так меньше шагов в демо-флоу
      await authStore.register({
        email: email.value.trim(),
        password: password.value,
        name: name.value.trim(),
        ...(refCode.value.trim() ? { referralCode: refCode.value.trim() } : {}),
      });
      await authStore.login(email.value.trim(), password.value);
    }
    void router.push('/');
  } catch (err) {
    const retryAfter = retryAfterFrom(err);
    if (retryAfter !== null) {
      // Привратник исчерпал корзину входа (брутфорс-лимит 5/мин на email) —
      // неверные попытки тоже списывают токены, ждём retryAfterSec из тела
      startCooldown(retryAfter);
      error.value = `Слишком много попыток входа — подождите ${retryAfter} с`;
    } else {
      error.value =
        apiMessage(err) ??
        (err instanceof Error ? err.message : 'Не получилось, попробуйте ещё раз');
    }
  } finally {
    submitting.value = false;
  }
}

async function submitCode(): Promise<void> {
  if (submitting.value || !secondFactor.value) return;
  submitting.value = true;
  error.value = null;
  try {
    await authStore.loginSecondFactor({
      ticket: secondFactor.value,
      code: otpCode.value.trim(),
      ...(trustDevice.value
        ? { trustDevice: true, deviceName: deviceName.value.trim() || 'Браузер' }
        : {}),
    });
    void router.push('/');
  } catch (err) {
    error.value =
      apiMessage(err) ??
      (err instanceof Error ? err.message : 'Не получилось, попробуйте ещё раз');
  } finally {
    submitting.value = false;
  }
}

/** назад к паролю: новый билет выдаст повторный логин */
function backToPassword(): void {
  secondFactor.value = null;
  demoHint.value = null;
  error.value = null;
}
</script>

<template>
  <section class="container auth">
    <h1 class="page-title">
      {{ secondFactor ? 'Код подтверждения' : mode === 'login' ? 'Вход' : 'Регистрация' }}
    </h1>

    <!-- шаг 2: код из приложения-аутентификатора или backup-код -->
    <form v-if="secondFactor" class="auth-form" @submit.prevent="submitCode">
      <p class="auth-note">
        Пароль верен — введите шестизначный код из приложения или backup-код.
      </p>

      <label class="field">
        <span class="field__label">Код</span>
        <input
          v-model="otpCode"
          class="field__input"
          type="text"
          required
          minlength="6"
          maxlength="14"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="123456 или AB2C-3DEF"
          data-testid="login-code-input"
        />
      </label>

      <p v-if="demoHint" class="auth-note" data-testid="login-demo-code">
        Демо без телефона: текущий код — <code>{{ demoHint }}</code>
      </p>

      <label class="auth-trust">
        <input v-model="trustDevice" type="checkbox" data-testid="login-trust-check" />
        <span>Доверять этому браузеру (30 дней без кода)</span>
      </label>

      <label v-if="trustDevice" class="field">
        <span class="field__label">Имя устройства</span>
        <input
          v-model="deviceName"
          class="field__input"
          type="text"
          maxlength="60"
          placeholder="Браузер на работе"
        />
      </label>

      <p v-if="error" class="auth-error">{{ error }}</p>

      <button class="btn" type="submit" :disabled="submitting">
        {{ submitting ? 'Проверяем…' : 'Войти' }}
      </button>

      <p class="auth-switch">
        Ошиблись пользователем?
        <button class="link" type="button" @click="backToPassword">
          Вернуться к паролю
        </button>
      </p>
    </form>

    <template v-else>
    <p v-if="appStore.mode === 'demo'" class="auth-note">
      Демо-режим: сессия симулируется в браузере и живёт до перезагрузки.
      Сработает любой email (кроме занятого <code>admin@cine.local</code> —
      увидите честный 409).
    </p>

    <form class="auth-form" @submit.prevent="submit">
      <label class="field">
        <span class="field__label">Email</span>
        <input
          v-model="email"
          class="field__input"
          type="email"
          required
          autocomplete="email"
          placeholder="you@example.com"
        />
      </label>

      <label v-if="mode === 'register'" class="field">
        <span class="field__label">Имя</span>
        <input
          v-model="name"
          class="field__input"
          type="text"
          required
          minlength="2"
          maxlength="60"
          placeholder="Как вас зовут?"
        />
      </label>

      <label v-if="mode === 'register'" class="field">
        <span class="field__label">Код приглашения</span>
        <input
          v-model="refCode"
          class="field__input"
          type="text"
          maxlength="12"
          placeholder="От друга (необязательно)"
          autocomplete="off"
        />
      </label>

      <label class="field">
        <span class="field__label">Пароль</span>
        <input
          v-model="password"
          class="field__input"
          type="password"
          required
          minlength="6"
          maxlength="72"
          autocomplete="current-password"
          placeholder="Минимум 6 символов"
        />
      </label>

      <p v-if="error" class="auth-error">{{ error }}</p>

      <button
        class="btn"
        type="submit"
        :disabled="submitting || cooldownSec > 0"
      >
        {{
          submitting
            ? 'Отправляем…'
            : cooldownSec
              ? `Подождите ${cooldownSec} с`
              : mode === 'login'
                ? 'Войти'
                : 'Зарегистрироваться'
        }}
      </button>

      <p class="auth-switch">
        <template v-if="mode === 'login'">
          Нет аккаунта?
          <button class="link" type="button" @click="mode = 'register'">
            Зарегистрироваться
          </button>
        </template>
        <template v-else>
          Уже есть аккаунт?
          <button class="link" type="button" @click="mode = 'login'">
            Войти
          </button>
        </template>
      </p>

      <p v-if="mode === 'login'" class="auth-switch">
        <RouterLink class="link" to="/forgot-password">Забыли пароль?</RouterLink>
      </p>

      <p class="auth-note">
        После входа бронь оформляется на ваше имя из профиля, а отменять можно
        только свои брони. Админ видит форму добавления сеансов.
      </p>
    </form>
    </template>
  </section>
</template>

<style scoped>
.auth {
  max-width: 420px;
}

.auth-form {
  display: grid;
  gap: 14px;
  margin-top: 16px;
}

.auth-error {
  color: #ff8080;
  margin: 0;
}

.auth-trust {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted, #9aa4b2);
  font-size: 0.92rem;
}

.auth-switch {
  margin: 0;
  color: var(--text-muted, #9aa4b2);
}

.auth-note {
  color: var(--text-muted, #9aa4b2);
  font-size: 0.9rem;
  margin: 8px 0 0;
}

.link {
  background: none;
  border: none;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
  font: inherit;
}
</style>
