<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SearchSuggestion } from '@/shared/api/types';
import { formatRating } from '@/shared/lib/format';
import { useMoviesStore } from '@/entities/movie/model/movies.store';

/** меньше двух символов поиск не беспокоим — подсказки раньше — шум */
const MIN_QUERY = 2;
/** дебаунс ввода: keystroke-шторм не должен молотить API */
const DEBOUNCE_MS = 300;

const emit = defineEmits<{ pick: [suggestion: SearchSuggestion] }>();

const moviesStore = useMoviesStore();
const query = ref('');
const suggestions = ref<SearchSuggestion[]>([]);
/** источник подсказок: фолбэк честно подписан в витрине */
const source = ref<'meilisearch' | 'db'>('meilisearch');
const loading = ref(false);
const error = ref<string | null>(null);
const open = ref(false);
/** подсвеченная клавиатурой подсказка; -1 — нет */
const activeIndex = ref(-1);

/** запрос, ответ которого ещё актуален: медленный ответ на старую
 *  фразу не должен затирать подсказки новой */
let requestEpoch = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const trimmed = computed(() => query.value.trim());
/** Enter без подсвеченной — берёт первую подсказку */
const active = computed(() =>
  activeIndex.value >= 0 ? suggestions.value[activeIndex.value] : undefined,
);

watch(query, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  activeIndex.value = -1;
  if (trimmed.value.length < MIN_QUERY) {
    suggestions.value = [];
    error.value = null;
    open.value = false;
    return;
  }
  debounceTimer = setTimeout(() => void search(), DEBOUNCE_MS);
});

async function search(): Promise<void> {
  const q = trimmed.value;
  if (q.length < MIN_QUERY) return;
  const epoch = ++requestEpoch;
  loading.value = true;
  error.value = null;
  try {
    const res = await moviesStore.search(q);
    if (epoch !== requestEpoch) return; // фраза уже сменилась
    suggestions.value = res.data;
    source.value = res.source;
    open.value = true;
  } catch (err) {
    if (epoch !== requestEpoch) return;
    suggestions.value = [];
    error.value = err instanceof Error ? err.message : 'Поиск недоступен';
    open.value = true; // отказ видно в той же панели, что и подсказки
  } finally {
    if (epoch === requestEpoch) loading.value = false;
  }
}

/** выбор подсказки: витрина открывает бронирование этого фильма */
function pick(suggestion: SearchSuggestion): void {
  open.value = false;
  emit('pick', suggestion);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' && suggestions.value.length) {
    event.preventDefault();
    open.value = true;
    activeIndex.value = (activeIndex.value + 1) % suggestions.value.length;
  } else if (event.key === 'ArrowUp' && suggestions.value.length) {
    event.preventDefault();
    activeIndex.value =
      activeIndex.value <= 0 ? suggestions.value.length - 1 : activeIndex.value - 1;
  } else if (event.key === 'Enter') {
    const chosen = active.value ?? suggestions.value[0];
    if (chosen) {
      event.preventDefault();
      pick(chosen);
    }
  } else if (event.key === 'Escape') {
    open.value = false;
  }
}

/** клик мимо — свернуть список (клик по подсказке раньше blur) */
function onDocClick(event: MouseEvent): void {
  if (!rootRef.value?.contains(event.target as Node)) open.value = false;
}
const rootRef = ref<HTMLElement | null>(null);

function onInputFocus(): void {
  if (suggestions.value.length || error.value) open.value = true;
}

onMounted(() => {
  document.addEventListener('mousedown', onDocClick);
});

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
  document.removeEventListener('mousedown', onDocClick);
});
</script>

<template>
  <div ref="rootRef" class="search-bar">
    <div class="search-bar__box" :class="{ 'search-bar__box--open': open }">
      <span class="search-bar__icon" aria-hidden="true">🔎</span>
      <input
        v-model="query"
        class="search-bar__input"
        type="search"
        aria-label="Поиск по афише"
        placeholder="Найти фильм: название, жанр, описание…"
        autocomplete="off"
        @keydown="onKeydown"
        @focus="onInputFocus"
      />
      <span
        v-if="loading"
        class="search-bar__spinner"
        aria-hidden="true"
      ></span>
    </div>

    <div
      v-if="open"
      class="search-bar__dropdown"
      role="listbox"
      aria-label="Подсказки поиска"
    >
      <p v-if="error" class="search-bar__empty">{{ error }}</p>
      <p v-else-if="!suggestions.length" class="search-bar__empty">
        Ничего не нашлось — попробуйте иначе
      </p>
      <template v-else>
        <button
          v-for="(s, i) in suggestions"
          :key="s.id"
          class="search-bar__option"
          :class="{ 'search-bar__option--active': i === activeIndex }"
          type="button"
          role="option"
          :aria-selected="i === activeIndex"
          @mousedown.prevent
          @click="pick(s)"
          @mouseenter="activeIndex = i"
        >
          <span
            class="search-bar__chip"
            :style="{
              background: `linear-gradient(135deg, hsl(${s.hue} 70% 55%), hsl(${(s.hue + 40) % 360} 70% 45%))`,
            }"
            aria-hidden="true"
          >
            {{ s.genreIcon }}
          </span>
          <span class="search-bar__title">{{ s.title }}</span>
          <span class="search-bar__meta">{{ s.genre }}</span>
          <span class="search-bar__rating" aria-hidden="true">
            ★ {{ formatRating(s.ratingAvg) }}
          </span>
        </button>
        <p
          v-if="source === 'db'"
          class="search-bar__fallback"
          title="Meilisearch недоступен — подсказки посчитаны подстрокой в базе"
        >
          поиск без движка — по подстроке
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.search-bar {
  position: relative;
  max-width: 560px;
}

.search-bar__box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color 0.15s ease;
}

.search-bar__box--open,
.search-bar__box:focus-within {
  border-color: var(--accent);
}

.search-bar__icon {
  font-size: 16px;
  opacity: 0.8;
}

.search-bar__input {
  flex: 1;
  padding: 12px 0;
  background: none;
  border: none;
  outline: none;
  color: var(--text);
  font: inherit;
}

.search-bar__input::placeholder {
  color: var(--muted);
}

.search-bar__input::-webkit-search-cancel-button {
  cursor: pointer;
}

.search-bar__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: search-bar-spin 0.7s linear infinite;
}

@keyframes search-bar-spin {
  to {
    transform: rotate(360deg);
  }
}

.search-bar__dropdown {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  padding: 6px;
  background: var(--bg-softer);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 12px 32px rgba(1, 4, 9, 0.55);
}

.search-bar__empty {
  padding: 10px 12px;
  color: var(--muted);
  font-size: 14px;
}

.search-bar__option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: none;
  border: none;
  border-radius: 8px;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.search-bar__option--active {
  background: var(--bg-soft);
}

.search-bar__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  font-size: 15px;
  flex-shrink: 0;
}

.search-bar__title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-bar__meta {
  color: var(--muted);
  font-size: 13px;
}

.search-bar__rating {
  color: var(--amber);
  font-size: 13px;
  flex-shrink: 0;
}

.search-bar__fallback {
  padding: 6px 12px 4px;
  color: var(--muted);
  font-size: 12px;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}
</style>
