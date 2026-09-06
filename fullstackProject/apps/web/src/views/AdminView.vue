<script setup lang="ts">
import { computed, ref } from 'vue';
import { ApiError } from '../api/client';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { useMoviesStore } from '../stores/movies';

const appStore = useAppStore();
const authStore = useAuthStore();
const moviesStore = useMoviesStore();

const title = ref('');
const description = ref('');
const genre = ref('');
const genreIcon = ref('🎬');
const durationMin = ref(100);
const priceRub = ref(400);
const hue = ref(220);
const sessionAt = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);
const success = ref<string | null>(null);

const allowed = computed(
  () => appStore.mode === 'live' && authStore.isAdmin,
);

async function submit(): Promise<void> {
  if (submitting.value || !sessionAt.value) return;
  submitting.value = true;
  error.value = null;
  success.value = null;
  try {
    const movie = await moviesStore.create({
      title: title.value,
      description: description.value,
      genre: genre.value,
      genreIcon: genreIcon.value,
      durationMin: durationMin.value,
      priceRub: priceRub.value,
      hue: hue.value,
      // datetime-local даёт локальное время без зоны — договоримся, что это МСК
      sessionAt: new Date(`${sessionAt.value}:00+03:00`).toISOString(),
    });
    success.value = `Сеанс «${movie.title}» в афише`;
    title.value = '';
    description.value = '';
    genre.value = '';
    sessionAt.value = '';
  } catch (err) {
    if (err instanceof ApiError) {
      try {
        const body = JSON.parse(err.body) as { message?: string };
        if (body.message) error.value = String(body.message);
      } catch {
        /* ниже общий текст */
      }
    }
    error.value ??= err instanceof Error ? err.message : 'Не удалось создать сеанс';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="container admin">
    <h1 class="page-title">Новый сеанс</h1>

    <p v-if="!allowed" class="admin-note">
      Раздел для администратора: войдите под админом при живом API
      (по умолчанию <code>admin@cine.local / admin-secret-1</code>).
    </p>

    <form v-else class="admin-form" @submit.prevent="submit">
      <label class="field">
        <span class="field__label">Название</span>
        <input
          v-model="title"
          class="field__input"
          type="text"
          required
          maxlength="120"
        />
      </label>

      <label class="field">
        <span class="field__label">Описание</span>
        <textarea
          v-model="description"
          class="field__input"
          required
          maxlength="500"
          rows="3"
        />
      </label>

      <div class="admin-row">
        <label class="field">
          <span class="field__label">Жанр</span>
          <input
            v-model="genre"
            class="field__input"
            type="text"
            required
            maxlength="40"
            placeholder="фантастика"
          />
        </label>
        <label class="field admin-row--icon">
          <span class="field__label">Иконка</span>
          <input
            v-model="genreIcon"
            class="field__input"
            type="text"
            required
            maxlength="8"
          />
        </label>
      </div>

      <div class="admin-row">
        <label class="field">
          <span class="field__label">Длительность, мин</span>
          <input
            v-model.number="durationMin"
            class="field__input"
            type="number"
            required
            min="10"
            max="300"
          />
        </label>
        <label class="field">
          <span class="field__label">Цена, ₽</span>
          <input
            v-model.number="priceRub"
            class="field__input"
            type="number"
            required
            min="0"
            max="100000"
          />
        </label>
        <label class="field">
          <span class="field__label">Оттенок постера (0–360)</span>
          <input
            v-model.number="hue"
            class="field__input"
            type="number"
            required
            min="0"
            max="360"
          />
        </label>
      </div>

      <label class="field">
        <span class="field__label">Дата и время сеанса</span>
        <input
          v-model="sessionAt"
          class="field__input"
          type="datetime-local"
          required
        />
      </label>

      <p v-if="error" class="admin-error">{{ error }}</p>
      <p v-if="success" class="admin-success">{{ success }}</p>

      <button class="btn" type="submit" :disabled="submitting">
        {{ submitting ? 'Создаём…' : 'Добавить в афишу' }}
      </button>

      <p class="admin-note">
        POST /api/movies — эндпоинт под @Roles('admin'); каталог после
        добавления покидает Redis-кэш и обновляется сразу.
      </p>
    </form>
  </section>
</template>

<style scoped>
.admin {
  max-width: 560px;
}

.admin-form {
  display: grid;
  gap: 14px;
  margin-top: 16px;
}

.admin-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

.admin-error {
  color: #ff8080;
  margin: 0;
}

.admin-success {
  color: #7dd87d;
  margin: 0;
}

.admin-note {
  color: var(--text-muted, #9aa4b2);
  font-size: 0.9rem;
  margin: 8px 0 0;
}
</style>
