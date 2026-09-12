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
/** сеансы нового фильма: зал + время; минимум один непустой */
const sessions = ref<{ hall: string; startsAt: string }[]>([
  { hall: 'Красный', startsAt: '' },
]);
const HALLS = ['Красный', 'IMAX'];
const submitting = ref(false);
const error = ref<string | null>(null);
const success = ref<string | null>(null);

const allowed = computed(
  () => appStore.mode === 'live' && authStore.isAdmin,
);

function addSession(): void {
  sessions.value.push({ hall: HALLS[0]!, startsAt: '' });
}

/** последнюю строку не убираем — фильм без сеансов не имеет смысла */
function dropSession(index: number): void {
  if (sessions.value.length > 1) sessions.value.splice(index, 1);
}

async function submit(): Promise<void> {
  const filled = sessions.value.filter((s) => s.startsAt);
  if (submitting.value || !filled.length) return;
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
      sessions: filled.map((s) => ({
        hall: s.hall,
        startsAt: new Date(`${s.startsAt}:00+03:00`).toISOString(),
      })),
    });
    success.value = `Фильм «${movie.title}» в афише, сеансов: ${filled.length}`;
    title.value = '';
    description.value = '';
    genre.value = '';
    sessions.value = [{ hall: HALLS[0]!, startsAt: '' }];
  } catch (err) {
    if (err instanceof ApiError) {
      try {
        const body = JSON.parse(err.body) as { message?: string };
        if (body.message) error.value = String(body.message);
      } catch {
        /* ниже общий текст */
      }
    }
    error.value ??= err instanceof Error ? err.message : 'Не удалось создать фильм';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="container admin">
    <h1 class="page-title">Новый фильм</h1>

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

      <div class="field">
        <span class="field__label">Сеансы (зал и время)</span>
        <div class="admin-sessions">
          <div
            v-for="(session, i) in sessions"
            :key="i"
            class="admin-session"
          >
            <select v-model="session.hall" class="field__input" required>
              <option v-for="hall in HALLS" :key="hall" :value="hall">
                {{ hall }}
              </option>
            </select>
            <input
              v-model="session.startsAt"
              class="field__input"
              type="datetime-local"
              :required="i === 0"
            />
            <button
              class="btn btn--ghost btn--sm"
              type="button"
              :disabled="sessions.length === 1"
              :aria-label="`Убрать сеанс ${i + 1}`"
              @click="dropSession(i)"
            >
              ✕
            </button>
          </div>
        </div>
        <button
          class="btn btn--ghost btn--sm admin-session-add"
          type="button"
          @click="addSession"
        >
          + Ещё сеанс
        </button>
      </div>

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

.admin-sessions {
  display: grid;
  gap: 8px;
}

/** строка сеанса: зал + время + снятие; на узких экранах переносится */
.admin-session {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) minmax(180px, 2fr) auto;
  gap: 8px;
  align-items: center;
}

.admin-session-add {
  margin-top: 8px;
  justify-self: start;
}

@media (max-width: 560px) {
  .admin-session {
    grid-template-columns: 1fr 1fr;
  }

  .admin-session button {
    grid-column: 1 / -1;
    justify-self: end;
  }
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
