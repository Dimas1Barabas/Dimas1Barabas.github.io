<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const appStore = useAppStore();
const authStore = useAuthStore();

const mode = ref<'login' | 'register'>('login');
const email = ref('');
const password = ref('');
const name = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

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

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  error.value = null;
  try {
    if (mode.value === 'login') {
      await authStore.login(email.value.trim(), password.value);
    } else {
      // после регистрации сразу входим — так меньше шагов в демо-флоу
      await authStore.register({
        email: email.value.trim(),
        password: password.value,
        name: name.value.trim(),
      });
      await authStore.login(email.value.trim(), password.value);
    }
    void router.push('/');
  } catch (err) {
    error.value =
      apiMessage(err) ??
      (err instanceof Error ? err.message : 'Не получилось, попробуйте ещё раз');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="container auth">
    <h1 class="page-title">
      {{ mode === 'login' ? 'Вход' : 'Регистрация' }}
    </h1>

    <p v-if="appStore.mode === 'demo'" class="auth-note">
      Демо-режим работает без бэкенда — авторизация доступна только при живом
      API (<code>docker compose up</code>).
    </p>

    <form v-else class="auth-form" @submit.prevent="submit">
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

      <button class="btn" type="submit" :disabled="submitting">
        {{
          submitting
            ? 'Отправляем…'
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

      <p class="auth-note">
        После входа бронь оформляется на ваше имя из профиля, а отменять можно
        только свои брони. Админ видит форму добавления сеансов.
      </p>
    </form>
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
