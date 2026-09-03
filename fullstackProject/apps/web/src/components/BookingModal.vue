<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Booking, Movie } from '../api/types';
import { formatPrice, formatSession } from '../utils/format';
import { useBookingsStore } from '../stores/bookings';

const props = defineProps<{ movie: Movie | null }>();
const emit = defineEmits<{ close: []; created: [booking: Booking] }>();

const bookingsStore = useBookingsStore();

const customerName = ref('');
const seats = ref(2);
const submitting = ref(false);
const error = ref<string | null>(null);

const total = computed(() =>
  props.movie ? props.movie.priceRub * seats.value : 0,
);

function clampSeats(value: number): void {
  seats.value = Math.min(8, Math.max(1, value));
}

async function submit(): Promise<void> {
  if (!props.movie || submitting.value) return;
  if (customerName.value.trim().length < 2) {
    error.value = 'Введите имя (минимум 2 символа)';
    return;
  }
  submitting.value = true;
  error.value = null;
  try {
    const booking = await bookingsStore.create({
      movieId: props.movie.id,
      customerName: customerName.value,
      seats: seats.value,
    });
    emit('created', booking);
  } catch (err) {
    error.value =
      err instanceof Error ? err.message : 'Не удалось создать бронь';
  } finally {
    submitting.value = false;
  }
}

// сброс формы при каждом открытии
watch(
  () => props.movie,
  () => {
    customerName.value = '';
    seats.value = 2;
    error.value = null;
  },
);
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="movie"
        class="modal-backdrop"
        @click.self="emit('close')"
        @keydown.esc="emit('close')"
      >
        <div class="modal" role="dialog" aria-modal="true">
          <header
            class="modal__head"
            :style="{
              background: `linear-gradient(120deg, hsl(${movie.hue} 70% 45%), hsl(${movie.hue + 55} 60% 25%))`,
            }"
          >
            <span class="modal__icon">{{ movie.genreIcon }}</span>
            <div>
              <h2 class="modal__title">{{ movie.title }}</h2>
              <p class="modal__meta">
                {{ movie.genre }} · {{ formatSession(movie.sessionAt) }}
              </p>
            </div>
            <button
              class="modal__close"
              type="button"
              aria-label="Закрыть"
              @click="emit('close')"
            >
              ✕
            </button>
          </header>

          <div class="modal__body">
            <label class="field">
              <span class="field__label">Ваше имя</span>
              <input
                v-model="customerName"
                class="field__input"
                type="text"
                maxlength="60"
                placeholder="Например, Дмитрий"
              />
            </label>

            <div class="field">
              <span class="field__label">Места</span>
              <div class="stepper">
                <button
                  class="stepper__btn"
                  type="button"
                  :disabled="seats <= 1"
                  @click="clampSeats(seats - 1)"
                >
                  −
                </button>
                <span class="stepper__value">{{ seats }}</span>
                <button
                  class="stepper__btn"
                  type="button"
                  :disabled="seats >= 8"
                  @click="clampSeats(seats + 1)"
                >
                  +
                </button>
              </div>
            </div>

            <p v-if="error" class="modal__error">{{ error }}</p>

            <p class="modal__note">
              После создания бронь получит статус «в обработке»: событие уйдёт в
              RabbitMQ, а Go-воркер ticket-worker «проведёт оплату» и вернёт
              вердикт.
            </p>
          </div>

          <footer class="modal__foot">
            <span class="modal__total">Итого: {{ formatPrice(total) }}</span>
            <div class="modal__actions">
              <button class="btn btn--ghost" type="button" @click="emit('close')">
                Отмена
              </button>
              <button
                class="btn"
                type="button"
                :disabled="submitting"
                @click="submit"
              >
                {{ submitting ? 'Отправляем…' : 'Забронировать' }}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
