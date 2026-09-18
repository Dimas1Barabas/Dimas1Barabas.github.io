<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '@/entities/viewer/model/store';

const authStore = useAuthStore();
const email = ref('');
const submitting = ref(false);
/** письмо «отправлено»: экран одинаков для любого email — не оракул */
const sent = ref(false);
/** демо-режим: «письмо» печатается здесь же — покажем ссылку сброса */
const demoToken = ref<string | null>(null);

async function submit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    demoToken.value = await authStore.forgotPassword(email.value.trim());
  } catch {
    // даже ошибку не раскрываем: экран успеха одинаков для любого email
    demoToken.value = null;
  } finally {
    sent.value = true;
    submitting.value = false;
  }
}
</script>

<template>
  <section class="container forgot">
    <h1 class="page-title">Восстановление пароля</h1>

    <template v-if="sent">
      <p class="auth-note">
        Если аккаунт существует, письмо со ссылкой уже отправлено. Ссылка
        действует 30 минут. На стенде письмо печатается в лог
        notification-service (<code>:18082/notifications</code>).
      </p>

      <p v-if="demoToken" class="auth-note">
        Демо: «письмо» печатается прямо здесь —
        <RouterLink class="link" :to="`/reset-password?token=${demoToken}`">
          открыть ссылку сброса
        </RouterLink>
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
