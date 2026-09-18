<script setup lang="ts">
import { ref } from 'vue';
import { api } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';

const appStore = useAppStore();
const email = ref('');
const submitting = ref(false);
/** письмо «отправлено»: экран одинаков для любого email — не оракул */
const sent = ref(false);

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    await api.forgotPassword(email.value.trim());
  } catch {
    // даже ошибку не раскрываем: экран успеха одинаков для любого email
  } finally {
    sent.value = true;
    submitting.value = false;
  }
}
</script>

<template>
  <section class="container forgot">
    <h1 class="page-title">Восстановление пароля</h1>

    <p v-if="appStore.mode === 'demo'" class="auth-note">
      Демо-режим работает без бэкенда — восстановление доступно только при
      живом API (<code>docker compose up</code>).
    </p>

    <template v-else-if="sent">
      <p class="auth-note">
        Если аккаунт существует, письмо со ссылкой уже отправлено. Ссылка
        действует 30 минут. На стенде письмо печатается в лог
        notification-service (<code>:18082/notifications</code>).
      </p>
      <RouterLink class="btn" to="/login">Вернуться ко входу</RouterLink>
    </template>

    <form v-else class="auth-form" @submit.prevent="submit">
      <label class="field">
        <span class="field__label">Email аккаунта</span>
        <input
          v-model="email"
          class="field__input"
          type="email"
          required
          autocomplete="email"
          placeholder="you@example.com"
        />
      </label>

      <button class="btn" type="submit" :disabled="submitting">
        {{ submitting ? 'Отправляем…' : 'Отправить ссылку' }}
      </button>

      <p class="auth-note">
        Ответ не зависит от того, существует ли email — так мы не раскрываем
        чужие аккаунты.
      </p>
    </form>
  </section>
</template>

<style scoped>
.forgot {
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

.auth-note {
  color: var(--text-muted, #9aa4b2);
  font-size: 0.9rem;
  margin: 8px 0 0;
}
</style>
