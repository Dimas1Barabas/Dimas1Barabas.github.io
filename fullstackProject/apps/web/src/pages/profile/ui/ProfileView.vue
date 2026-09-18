<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError } from '@/shared/api/client';
import { useAuthStore } from '@/entities/viewer/model/store';

const authStore = useAuthStore();
const allowed = computed(() => authStore.isAuthed);

const email = ref(authStore.user?.email ?? '');
const name = ref(authStore.user?.name ?? '');
const savingProfile = ref(false);
const profileError = ref<string | null>(null);
const profileNote = ref<string | null>(null);

const currentPassword = ref('');
const newPassword = ref('');
const newPasswordRepeat = ref('');
const changingPassword = ref(false);
const passwordError = ref<string | null>(null);
const passwordNote = ref<string | null>(null);

/** 401/403/409 у API несут человекочитаемый message — показываем его */
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

async function saveProfile(): Promise<void> {
  if (savingProfile.value) return;
  savingProfile.value = true;
  profileError.value = null;
  profileNote.value = null;
  try {
    const payload: { email?: string; name?: string } = {};
    if (email.value.trim() !== authStore.user?.email) payload.email = email.value.trim();
    if (name.value.trim() !== authStore.user?.name) payload.name = name.value.trim();
    if (!payload.email && !payload.name) {
      profileNote.value = 'Изменений нет';
      return;
    }
    await authStore.updateProfile(payload);
    profileNote.value = 'Сохранено';
  } catch (err) {
    profileError.value =
      apiMessage(err) ??
      (err instanceof Error ? err.message : 'Не получилось, попробуйте ещё раз');
  } finally {
    savingProfile.value = false;
  }
}

async function changePassword(): Promise<void> {
  if (changingPassword.value) return;
  passwordError.value = null;
  passwordNote.value = null;
  if (newPassword.value !== newPasswordRepeat.value) {
    passwordError.value = 'Новые пароли не совпадают';
    return;
  }
  changingPassword.value = true;
  try {
    // смена ревокает все сессии (в live), это устройство остаётся
    await authStore.changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    });
    currentPassword.value = '';
    newPassword.value = '';
    newPasswordRepeat.value = '';
    passwordNote.value = 'Пароль сменён, другие устройства вышли';
  } catch (err) {
    passwordError.value =
      apiMessage(err) ??
      (err instanceof Error ? err.message : 'Не получилось, попробуйте ещё раз');
  } finally {
    changingPassword.value = false;
  }
}
</script>

<template>
  <section class="container profile">
    <h1 class="page-title">Профиль</h1>

    <template v-if="!allowed">
      <p class="auth-note">Профиль виден только владельцу сессии.</p>
      <RouterLink class="btn" to="/login">Войти</RouterLink>
    </template>

    <template v-else>
      <form class="profile-form" @submit.prevent="saveProfile">
        <h2 class="profile-subtitle">Аккаунт</h2>

        <label class="field">
          <span class="field__label">Email</span>
          <input
            v-model="email"
            class="field__input"
            type="email"
            required
            autocomplete="email"
          />
        </label>

        <label class="field">
          <span class="field__label">Имя</span>
          <input
            v-model="name"
            class="field__input"
            type="text"
            required
            minlength="2"
            maxlength="60"
            autocomplete="name"
          />
        </label>

        <p v-if="profileError" class="auth-error">{{ profileError }}</p>
        <p v-if="profileNote" class="auth-note">{{ profileNote }}</p>

        <button class="btn" type="submit" :disabled="savingProfile">
          {{ savingProfile ? 'Сохраняем…' : 'Сохранить' }}
        </button>
      </form>

      <form class="profile-form" @submit.prevent="changePassword">
        <h2 class="profile-subtitle">Смена пароля</h2>

        <label class="field">
          <span class="field__label">Текущий пароль</span>
          <input
            v-model="currentPassword"
            class="field__input"
            type="password"
            required
            autocomplete="current-password"
          />
        </label>

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

        <p v-if="passwordError" class="auth-error">{{ passwordError }}</p>
        <p v-if="passwordNote" class="auth-note">{{ passwordNote }}</p>

        <button class="btn" type="submit" :disabled="changingPassword">
          {{ changingPassword ? 'Меняем…' : 'Сменить пароль' }}
        </button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.profile {
  max-width: 460px;
}

.profile-form {
  display: grid;
  gap: 14px;
  margin-top: 16px;
}

.profile-form + .profile-form {
  margin-top: 28px;
}

.profile-subtitle {
  font-size: 1.05rem;
  margin: 0;
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
