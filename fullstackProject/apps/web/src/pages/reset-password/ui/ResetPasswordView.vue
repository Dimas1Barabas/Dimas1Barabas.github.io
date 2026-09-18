<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '@/shared/api/client';
import { useAuthStore } from '@/entities/viewer/model/store';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

/** токен одноразовой ссылки: /reset-password?token=… */
const token = computed(() => {
  const raw = route.query.token;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
});

const newPassword = ref('');
const newPasswordRepeat = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);
/** 400 от API: ссылка мертва — предлагаем запросить новую */
const linkDead = ref(false);

async function submit(): Promise<void> {
  if (submitting.value || !token.value) return;
  error.value = null;
  linkDead.value = false;
  if (newPassword.value !== newPasswordRepeat.value) {
    error.value = 'Пароли не совпадают';
    return;
  }
  submitting.value = true;
  try {
    // сброс сразу логинит это устройство: ответ — свежая пара
    await authStore.resetPassword(token.value, newPassword.value);
    void router.push('/');
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      error.value = 'Ссылка недействительна или истекла — запросите новую';
      linkDead.value = true;
      return;
    }
    error.value = err instanceof Error ? err.message : 'Не получилось';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="container reset">
    <h1 class="page-title">Новый пароль</h1>

    <p v-if="!token" class="auth-error">
      Ссылка неполная — токен сброса не найден. Запросите новое письмо.
    </p>

    <form v-else class="auth-form" @submit.prevent="submit">
      <label class="field">
        <span class="field__label">Новый пароль</span>
        <input
          v-model="newPassword"
          class="field__input"
          type="password"
          required
          minlength="6"
          maxlength="72"
          autocomplete="new-password"
          placeholder="Минимум 6 символов"
        />
      </label>

      <label class="field">
        <span class="field__label">Новый пароль ещё раз</span>
        <input
          v-model="newPasswordRepeat"
          class="field__input"
          type="password"
          required
          minlength="6"
          maxlength="72"
          autocomplete="new-password"
        />
      </label>

      <p v-if="error" class="auth-error">{{ error }}</p>

      <button class="btn" type="submit" :disabled="submitting">
        {{ submitting ? 'Сохраняем…' : 'Сменить пароль и войти' }}
      </button>

      <p class="auth-note">
        Ссылка одноразовая и живёт 30 минут. Смена пароля выходит вами со всех
        устройств — кроме этого.
      </p>
    </form>

    <RouterLink
      v-if="!token || linkDead"
      class="link forgot-link"
      to="/forgot-password"
    >
      Запросить новую ссылку
    </RouterLink>
  </section>
</template>

<style scoped>
.reset {
  max-width: 420px;
}

.auth-form {
  display: grid;
  gap: 14px;
  margin-top: 16px;
}

.auth-error {
  color: #ff8080;
  margin: 8px 0 0;
}

.auth-note {
  color: var(--text-muted, #9aa4b2);
  font-size: 0.9rem;
  margin: 8px 0 0;
}

.forgot-link {
  display: inline-block;
  margin-top: 12px;
  color: inherit;
}

.link {
  text-decoration: underline;
}
</style>
