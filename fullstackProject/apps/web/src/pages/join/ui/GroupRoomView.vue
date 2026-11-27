<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useGroupStore } from '@/entities/group/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useBookingsStore } from '@/entities/booking/model/store';
import { useAppStore } from '@/shared/api/app-mode';
import { formatCountdown } from '@/shared/lib/format';
import { storedToken } from '@/shared/api/client';
import SeatPicker from '@/features/booking-flow/ui/SeatPicker.vue';

/**
 * Комната группы «Идём вместе» (/join/:code): общая live-карта с цветными
 * пометками выборов участников, панель «кто в группе» с готовностью,
 * фиксация по готовности всех, бронь своих мест после фиксации.
 */
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const groupStore = useGroupStore();
const moviesStore = useMoviesStore();
const bookingsStore = useBookingsStore();

const nameInput = ref('');
const bookingError = ref<string | null>(null);
const booking = ref(false);
const inviteCopied = ref(false);
/** тикающее «сейчас» для обратного отсчёта распада */
const nowMs = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

const code = computed(() => String(route.params.code ?? ''));

/** фильм сеанса группы — по каталогу афиши (сеанс → фильм) */
const movie = computed(() => {
  const sessionId = groupStore.room?.sessionId ?? groupStore.preview?.sessionId;
  if (!sessionId) return null;
  for (const movie of moviesStore.movies) {
    if (movie.sessions.some((s) => s.id === sessionId)) return movie;
  }
  return null;
});

const sessionLabel = computed(() => {
  const sessionId = groupStore.room?.sessionId ?? groupStore.preview?.sessionId;
  const session = movie.value?.sessions.find((s) => s.id === sessionId);
  return session ? new Date(session.startsAt).toLocaleString('ru-RU') : '';
});

const inviteLink = computed(() =>
  code.value ? `${location.origin}${location.pathname}#/join/${code.value}` : '',
);

const msLeft = computed(() =>
  Math.max(0, (groupStore.room?.expiresAt ?? 0) - nowMs.value),
);

const conflicts = computed(() => groupStore.room?.conflicts ?? []);
const isFixed = computed(() => groupStore.room?.status === 'fixed');
const amReady = computed(() => groupStore.me?.ready ?? false);
const mySeats = computed({
  get: () => groupStore.mySeats,
  set: (seats: string[]) => groupStore.selectSeats(seats),
});

function autoEnter(): void {
  // без имени заходят только те, у кого уже есть личность (создатель/реконнект)
  if (groupStore.phase === 'preview' && storedParticipant(code.value)) {
    groupStore.enter(code.value, '');
  }
}

async function joinWithName(): Promise<void> {
  if (nameInput.value.trim().length < 2) return;
  groupStore.enter(code.value, nameInput.value.trim());
}

async function copyInvite(): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    inviteCopied.value = true;
    setTimeout(() => {
      inviteCopied.value = false;
    }, 2500);
  } catch {
    /* буфер недоступен — ссылку можно выделить руками */
  }
}

/** бронь своих мест после фиксации: обычный флоу, свой платёж */
async function bookSeats(): Promise<void> {
  const room = groupStore.room;
  const seats = groupStore.me?.seats ?? [];
  if (!room || seats.length === 0) return;
  bookingError.value = null;
  booking.value = true;
  try {
    const created = await bookingsStore.create({
      sessionId: room.sessionId,
      seats,
      // гостю — имя участника; авторизованный брониет на профиль
      ...(storedToken() ? {} : { customerName: groupStore.me?.name }),
    });
    groupStore.markBooked();
    await router.push(`/pay/${created.id}`);
  } catch (err) {
    // место могли занять внешней бронью за время фиксации
    bookingError.value =
      err instanceof Error ? err.message : 'Бронь не оформлена';
  } finally {
    booking.value = false;
  }
}

function goHome(): void {
  groupStore.reset();
  void router.push('/');
}

/** sessionStorage-личность по коду (для авто-входа без формы имени) */
function storedParticipant(groupCode: string): string | null {
  try {
    return sessionStorage.getItem(`cine.group.${groupCode}`);
  } catch {
    return null;
  }
}

onMounted(() => {
  void moviesStore.load();
  void groupStore.loadPreview(code.value).then(autoEnter);
  tickTimer = setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  groupStore.stop();
  if (tickTimer) clearInterval(tickTimer);
});
</script>

<template>
  <section class="group-room">
    <!-- ссылка умерла -->
    <div v-if="groupStore.previewError" class="group-room__placeholder">
      <h1>Ссылка не работает</h1>
      <p>{{ groupStore.previewError }}</p>
      <button type="button" class="btn" @click="goHome">В афишу</button>
    </div>

    <!-- превью + вход именем -->
    <div v-else-if="groupStore.phase === 'preview'" class="group-room__join">
      <h1>Вас зовут в кино<span v-if="movie">: {{ movie.title }}</span></h1>
      <p v-if="sessionLabel" class="group-room__session">{{ sessionLabel }}</p>
      <p v-if="groupStore.preview" class="group-room__meta">
        Участников: {{ groupStore.preview.participants.length }} ·
        {{ groupStore.preview.status === 'fixed' ? 'выбор зафиксирован' : 'выбирают места' }}
      </p>
      <form
        v-if="!storedParticipant(code)"
        class="group-room__form"
        @submit.prevent="joinWithName"
      >
        <label class="field">
          <span class="field__label">Ваше имя</span>
          <input
            v-model="nameInput"
            class="field__input"
            type="text"
            placeholder="Как вас представят друзьям"
            minlength="2"
            maxlength="60"
            required
          />
        </label>
        <button type="submit" class="btn" :disabled="nameInput.trim().length < 2">
          Войти в группу
        </button>
      </form>
      <p v-else class="group-room__meta">Возвращаемся в группу…</p>
    </div>

    <!-- группа распалась -->
    <div v-else-if="groupStore.phase === 'disbanded'" class="group-room__placeholder">
      <h1>Группа распалась</h1>
      <p>
        Время выбора вышло или все разошлись. Ничего не потеряно — соберите
        группу заново из окна брони.
      </p>
      <button type="button" class="btn" @click="goHome">В афишу</button>
    </div>

    <!-- комната -->
    <div v-else-if="groupStore.room" class="group-room__live">
      <header class="group-room__head">
        <div>
          <h1><span v-if="movie">{{ movie.title }} ·</span> идём вместе</h1>
          <p v-if="sessionLabel" class="group-room__session">{{ sessionLabel }}</p>
        </div>
        <div class="group-room__invite">
          <span class="group-room__code">{{ groupStore.room.code }}</span>
          <button type="button" class="btn btn--ghost" @click="copyInvite">
            {{ inviteCopied ? 'Скопировано ✓' : 'Скопировать ссылку' }}
          </button>
        </div>
      </header>

      <p class="group-room__timer">
        {{ isFixed ? 'на брони осталось' : 'группа распадётся через' }}
        {{ formatCountdown(msLeft) }}
      </p>

      <div class="group-room__body">
        <div class="group-room__map">
          <SeatPicker
            v-model="mySeats"
            :rows="8"
            :seats-per-row="10"
            :occupied="groupStore.room.occupied"
            :marks="groupStore.marks"
          />
          <p v-if="conflicts.length" class="group-room__conflicts">
            Оспариваются: {{ conflicts.join(', ') }} — договоритесь, кто уступит
          </p>
        </div>

        <aside class="group-room__side">
          <h2>В группе</h2>
          <ul class="group-room__participants">
            <li
              v-for="p in groupStore.room.participants"
              :key="p.id"
              class="group-room__participant"
              :class="{ 'group-room__participant--offline': !p.online }"
            >
              <span
                class="group-room__swatch"
                :style="{ background: p.color }"
              />
              <span class="group-room__participant-name">
                {{ p.name }}<template v-if="p.id === groupStore.room.you"> (вы)</template>
              </span>
              <span v-if="p.booked" class="chip">бронь ✓</span>
              <span v-else-if="p.ready" class="chip">готов</span>
              <span v-else class="chip chip--muted">выбирает</span>
            </li>
          </ul>

          <div v-if="!isFixed" class="group-room__actions">
            <button
              type="button"
              class="btn"
              :class="{ 'btn--ghost': amReady }"
              :disabled="groupStore.mySeats.length === 0"
              @click="groupStore.toggleReady(!amReady)"
            >
              {{ amReady ? 'Передумал — выбираю дальше' : 'Готов' }}
            </button>
            <p class="group-room__hint">
              {{
                groupStore.pendingCount === 0
                  ? 'Ждём вас'
                  : `Ждём ещё ${groupStore.pendingCount}` +
                    (groupStore.pendingCount === 1 ? ' участника' : ' участников')
              }}
            </p>
          </div>

          <div v-else class="group-room__actions">
            <button
              type="button"
              class="btn"
              :disabled="booking || (groupStore.me?.booked ?? false)"
              @click="bookSeats"
            >
              {{
                groupStore.me?.booked
                  ? 'Места забронированы ✓'
                  : booking
                    ? 'Оформляем…'
                    : `Забронировать мои места (${groupStore.mySeats.length})`
              }}
            </button>
            <p class="group-room__hint">
              Выбор зафиксирован — каждый бронирует и платит за свои места
            </p>
          </div>

          <p v-if="groupStore.lastError" class="group-room__error">
            {{ groupStore.lastError }}
          </p>
          <p v-if="bookingError" class="group-room__error">{{ bookingError }}</p>

          <button type="button" class="btn btn--ghost" @click="groupStore.leave()">
            Покинуть группу
          </button>
        </aside>
      </div>
    </div>
  </section>
</template>

<style scoped>
.group-room {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 16px;
  display: grid;
  gap: 20px;
}

.group-room__placeholder,
.group-room__join {
  display: grid;
  gap: 12px;
  justify-items: start;
  padding: 32px 0;
}

.group-room__form {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}

.group-room__meta,
.group-room__session,
.group-room__hint,
.group-room__timer {
  color: var(--text-dim, #9aa4b2);
  font-size: 14px;
}

.group-room__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}

.group-room__invite {
  display: flex;
  gap: 10px;
  align-items: center;
}

.group-room__code {
  font-family: var(--font-mono, monospace);
  font-size: 20px;
  letter-spacing: 3px;
  color: var(--accent, var(--token-cyan, #22d3ee));
}

.group-room__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 20px;
  align-items: start;
}

@media (max-width: 860px) {
  .group-room__body {
    grid-template-columns: 1fr;
  }
}

.group-room__map {
  overflow-x: auto;
}

.group-room__side {
  display: grid;
  gap: 12px;
}

.group-room__participants {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.group-room__participant {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 14px;
}

.group-room__participant--offline .group-room__participant-name {
  opacity: 0.55;
}

.group-room__swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex: none;
}

.group-room__participant-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-room__actions {
  display: grid;
  gap: 6px;
}

.group-room__conflicts,
.group-room__error {
  color: #f87171;
  font-size: 14px;
}

.chip--muted {
  opacity: 0.6;
}
</style>
