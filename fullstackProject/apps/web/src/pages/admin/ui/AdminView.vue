<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ApiError } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { usePromosStore } from '@/entities/promo/model/promos.store';
import type { Promo } from '@/shared/api/types';
import type { PromoKind } from '@/shared/lib/promo';

const appStore = useAppStore();
const authStore = useAuthStore();
const moviesStore = useMoviesStore();
const promosStore = usePromosStore();

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

// ── Промокоды ─────────────────────────────────────────────────────
// В демо раздел открыт всем (витрина Pages), в live — только админу:
// как аналитика. Списание активации — в момент оплаты, см. промо-блок
// на экране /pay/:bookingId.

/** промокоды: как аналитика — админам в live и всем в демо */
const promosAllowed = computed(
  () => appStore.mode === 'demo' || (appStore.mode === 'live' && authStore.isAdmin),
);

const promoCode = ref('');
const promoKind = ref<PromoKind>('percent');
const promoValue = ref(10);
const promoMaxActivations = ref(100);
const promoSubmitting = ref(false);
const promoError = ref<string | null>(null);
const promoSuccess = ref<string | null>(null);

/** datetime-local любит локальное «YYYY-MM-DDTHH:mm» — дефолт +30 дней */
function defaultExpiry(): string {
  const d = new Date(Date.now() + 30 * 86_400_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
const promoExpiresAt = ref(defaultExpiry());

/** режим мог прийти после монта (демо-детект по /health) — следим */
watch(
  promosAllowed,
  (ok) => {
    if (ok) void promosStore.refresh();
  },
  { immediate: true },
);

function promoExpired(p: Promo): boolean {
  return Date.parse(p.expiresAt) <= Date.now();
}

function promoExpiryLabel(p: Promo): string {
  return new Date(p.expiresAt).toLocaleDateString('ru-RU');
}

async function submitPromo(): Promise<void> {
  if (promoSubmitting.value) return;
  promoSubmitting.value = true;
  promoError.value = null;
  promoSuccess.value = null;
  try {
    const promo = await promosStore.create({
      code: promoCode.value,
      kind: promoKind.value,
      value: promoValue.value,
      maxActivations: promoMaxActivations.value,
      // datetime-local даёт локальное время без зоны — договоримся, что это МСК
      expiresAt: new Date(`${promoExpiresAt.value}:00+03:00`).toISOString(),
    });
    promoSuccess.value = `Промокод ${promo.code} создан`;
    promoCode.value = '';
  } catch (err) {
    if (err instanceof ApiError) {
      try {
        const body = JSON.parse(err.body) as { message?: string };
        if (body.message) promoError.value = String(body.message);
      } catch {
        /* ниже общий текст */
      }
    }
    promoError.value ??= err instanceof Error ? err.message : 'Не удалось создать промокод';
  } finally {
    promoSubmitting.value = false;
  }
}

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
    <h1 class="page-title">Админка</h1>

    <!-- промокоды: как аналитика — в демо открыты всем, в live админу -->
    <section v-if="promosAllowed" class="admin-promos">
      <div class="admin-promos__head">
        <h2 class="admin-promos__title">Промокоды</h2>
        <span v-if="appStore.mode === 'demo'" class="admin-promos__badge">
          демо-данные
        </span>
      </div>

      <form class="admin-form promo-form" @submit.prevent="submitPromo">
        <div class="admin-row">
          <label class="field">
            <span class="field__label">Код</span>
            <input
              v-model="promoCode"
              class="field__input"
              type="text"
              required
              maxlength="32"
              placeholder="CINE10"
            />
          </label>
          <label class="field">
            <span class="field__label">Вид скидки</span>
            <select v-model="promoKind" class="field__input" required>
              <option value="percent">Процент</option>
              <option value="fixed">Фикс, ₽</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">
              {{ promoKind === 'percent' ? 'Размер, %' : 'Размер, ₽' }}
            </span>
            <input
              v-model.number="promoValue"
              class="field__input"
              type="number"
              required
              min="1"
              :max="promoKind === 'percent' ? 99 : 1000000"
            />
          </label>
        </div>

        <div class="admin-row">
          <label class="field">
            <span class="field__label">Лимит активаций</span>
            <input
              v-model.number="promoMaxActivations"
              class="field__input"
              type="number"
              required
              min="1"
              max="1000000"
            />
          </label>
          <label class="field">
            <span class="field__label">Действует до</span>
            <input
              v-model="promoExpiresAt"
              class="field__input"
              type="datetime-local"
              required
            />
          </label>
        </div>

        <p v-if="promoError" class="admin-error">{{ promoError }}</p>
        <p v-if="promoSuccess" class="admin-success">{{ promoSuccess }}</p>

        <button class="btn" type="submit" :disabled="promoSubmitting">
          {{ promoSubmitting ? 'Создаём…' : 'Создать промокод' }}
        </button>
      </form>

      <p v-if="promosStore.loading" class="admin-note">Загружаем промокоды…</p>
      <p v-else-if="promosStore.error" class="admin-error">
        {{ promosStore.error }}
      </p>
      <ul v-else-if="promosStore.promos.length" class="admin-promo-list">
        <li v-for="p in promosStore.promos" :key="p.id" class="admin-promo">
          <span class="admin-promo__code">{{ p.code }}</span>
          <span class="admin-promo__value">
            {{ p.kind === 'percent' ? `−${p.value}%` : `−${p.value} ₽` }}
          </span>
          <span
            class="admin-promo__used"
            :class="{ 'admin-promo__used--done': p.usedCount >= p.maxActivations }"
          >
            {{ p.usedCount }}/{{ p.maxActivations }}
          </span>
          <span
            class="admin-promo__expiry"
            :class="{ 'admin-promo__expiry--old': promoExpired(p) }"
          >
            {{ promoExpired(p) ? 'истёк' : `до ${promoExpiryLabel(p)}` }}
          </span>
        </li>
      </ul>
      <p v-else class="admin-note">Промокодов пока нет — создайте первый.</p>

      <p class="admin-note">
        Активация списывается атомарно в момент оплаты: гонку за последний
        код решает БД (POST /bookings/:id/pay с полем promoCode).
      </p>
    </section>

    <h2 class="admin-movies-title">Новый фильм</h2>

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

.admin-promos {
  margin-top: 16px;
}

.admin-promos__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.admin-promos__title {
  margin: 0;
  font-size: 1.15rem;
}

.admin-promos__badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
}

.admin-promo-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.admin-promo {
  display: grid;
  grid-template-columns: minmax(90px, 1.2fr) auto auto auto;
  gap: 8px;
  align-items: baseline;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.admin-promo__code {
  font-weight: 600;
  letter-spacing: 0.04em;
}

.admin-promo__value {
  color: var(--cyan);
}

.admin-promo__used {
  color: var(--muted);
}

.admin-promo__used--done {
  text-decoration: line-through;
  color: var(--muted);
}

.admin-promo__expiry {
  color: var(--muted);
  font-size: 0.85rem;
}

.admin-promo__expiry--old {
  color: #ff8080;
}

.admin-movies-title {
  margin: 28px 0 0;
  font-size: 1.15rem;
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
