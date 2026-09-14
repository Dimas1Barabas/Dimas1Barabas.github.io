import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, Movie, Review, User } from '../api/types';
import { ApiError } from '../api/client';
import { useAppStore } from '../stores/app';
import { useAuthStore } from '../stores/auth';
import { useBookingsStore } from '../stores/bookings';
import { useReviewsStore } from '../stores/reviews';
import ReviewModal from './ReviewModal.vue';

/**
 * Модалка отзывов: демо-режим по умолчанию (без сети), сторы замоканы
 * на уровне действий — как в BookingModal.spec. Teleport стабится,
 * чтобы контент рендерился инлайн и был доступен find'ом.
 */

const movie: Movie = {
  id: 'm-1',
  title: 'Рекурсия',
  description: 'Фильм о вложенных снах.',
  genre: 'хоррор',
  genreIcon: '🌀',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  ratingAvg: 4.5,
  ratingCount: 2,
  sessions: [
    { id: 's-1', hall: 'IMAX', startsAt: new Date(2030, 0, 10, 19, 0).toISOString() },
  ],
};

function reviewFixture(overrides: Partial<Review> = {}): Review {
  return {
    id: 'r-1',
    movieId: movie.id,
    userId: 'u-9',
    authorName: 'Ольга',
    rating: 5,
    text: 'Смотрела не отрываясь!',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...overrides,
  };
}

const admin: User = {
  id: 'admin-1',
  email: 'admin@cine.local',
  name: 'Админ',
  role: 'admin',
  createdAt: '2026-09-01T00:00:00Z',
};

/** свежий pinia + демо-режим; сетевые действия сторов замоканы */
function setup() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const appStore = useAppStore();
  appStore.mode = 'demo';
  const reviewsStore = useReviewsStore();
  reviewsStore.loadFor = vi.fn();
  const bookingsStore = useBookingsStore();
  bookingsStore.refresh = vi.fn();
  bookingsStore.refreshMine = vi.fn();
  return { pinia, appStore, reviewsStore, bookingsStore };
}

function mountModal(
  pinia: ReturnType<typeof createPinia>,
  current: Movie | null = movie,
) {
  return mount(ReviewModal, {
    props: { movie: current },
    global: { plugins: [pinia], stubs: { Teleport: true, RouterLink: RouterLinkStub } },
  });
}

describe('ReviewModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('рендерит список отзывов и сводку рейтинга', async () => {
    const { pinia, reviewsStore } = setup();
    reviewsStore.byMovie[movie.id] = [
      reviewFixture(),
      reviewFixture({ id: 'r-2', userId: 'u-8', authorName: 'Игорь', rating: 4 }),
    ];

    const wrapper = mountModal(pinia);
    await flushPromises();

    expect(wrapper.findAll('.review-item')).toHaveLength(2);
    expect(wrapper.text()).toContain('Ольга');
    expect(wrapper.text()).toContain('Игорь');
    // сводка: средняя с запятой и склонённое число отзывов
    expect(wrapper.find('.review-summary__text').text()).toContain('4,5');
    expect(wrapper.find('.review-summary__text').text()).toContain('2 отзыва');
    // при открытии подтянули список
    expect(reviewsStore.loadFor).toHaveBeenCalledWith(movie.id);
  });

  it('нет отзывов — «станьте первым», форма скрыта без брони', async () => {
    const { pinia } = setup();

    const wrapper = mountModal(pinia);
    await flushPromises();

    expect(wrapper.text()).toContain('Отзывов ещё нет');
    expect(wrapper.find('.review-form').exists()).toBe(false);
    // подсказка про правило права на отзыв
    expect(wrapper.text()).toContain('после подтверждённой брони');
  });

  it('форма появляется при подтверждённой брони (демо)', async () => {
    const { pinia, bookingsStore } = setup();
    bookingsStore.bookings = [
      { movieId: movie.id, status: 'CONFIRMED' } as Booking,
    ];

    const wrapper = mountModal(pinia);
    await flushPromises();

    expect(wrapper.find('.review-form').exists()).toBe(true);
  });

  it('звёзды формы: сабмит заблокирован без оценки, клик выбирает', async () => {
    const { pinia, bookingsStore } = setup();
    bookingsStore.bookings = [
      { movieId: movie.id, status: 'CONFIRMED' } as Booking,
    ];
    const wrapper = mountModal(pinia);
    await flushPromises();

    const submit = wrapper.find('.review-form button[type="submit"]');
    expect(submit.attributes('disabled')).toBeDefined();

    await wrapper.findAll('.rating-input__star')[3].trigger('click'); // 4 из 5
    expect(submit.attributes('disabled')).toBeUndefined();
    expect(wrapper.findAll('.rating-input__star--active')).toHaveLength(4);
  });

  it('сабмит отправляет оценку и текст через стор', async () => {
    const { pinia, reviewsStore, bookingsStore } = setup();
    bookingsStore.bookings = [
      { movieId: movie.id, status: 'CONFIRMED' } as Booking,
    ];
    reviewsStore.create = vi.fn().mockResolvedValue(reviewFixture({ userId: 'demo-guest' }));
    const wrapper = mountModal(pinia);
    await flushPromises();

    await wrapper.findAll('.rating-input__star')[4].trigger('click');
    await wrapper.find('textarea').setValue('Очень зашло, смотрели всей семьёй.');
    await wrapper.find('.review-form').trigger('submit');

    expect(reviewsStore.create).toHaveBeenCalledWith(movie.id, {
      rating: 5,
      text: 'Очень зашло, смотрели всей семьёй.',
    });
  });

  it('409 дубля — сообщение из тела ответа API', async () => {
    const { pinia, reviewsStore, bookingsStore } = setup();
    bookingsStore.bookings = [
      { movieId: movie.id, status: 'CONFIRMED' } as Booking,
    ];
    reviewsStore.create = vi.fn().mockRejectedValue(
      new ApiError(
        'HTTP 409',
        409,
        JSON.stringify({
          statusCode: 409,
          message: 'Вы уже оставили отзыв на этот фильм',
          code: 'reviewExists',
        }),
      ),
    );
    const wrapper = mountModal(pinia);
    await flushPromises();

    await wrapper.findAll('.rating-input__star')[0].trigger('click');
    await wrapper.find('textarea').setValue('Хочу написать второй отзыв.');
    await wrapper.find('.review-form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('.modal__error').text()).toContain(
      'Вы уже оставили отзыв на этот фильм',
    );
  });

  it('удаление: свой (гость демо) отзыв можно, чужой — нельзя', async () => {
    const { pinia, reviewsStore } = setup();
    reviewsStore.byMovie[movie.id] = [
      reviewFixture(), // чужой
      reviewFixture({ id: 'r-me', userId: 'demo-guest', authorName: 'Гость' }),
    ];
    reviewsStore.remove = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountModal(pinia);
    await flushPromises();

    const dels = wrapper.findAll('.review-item__del');
    expect(dels).toHaveLength(1); // только свой

    await dels[0].trigger('click');
    expect(reviewsStore.remove).toHaveBeenCalledWith(movie.id, 'r-me');
  });

  it('live + админ: удаление чужого отзыва доступно, формы нет без брони', async () => {
    const { pinia, appStore, reviewsStore } = setup();
    appStore.mode = 'live';
    const authStore = useAuthStore();
    // isAuthed смотрит на токен — проставляем сессию целиком
    authStore.token = 'jwt-admin';
    authStore.user = admin;
    reviewsStore.byMovie[movie.id] = [reviewFixture()];
    reviewsStore.remove = vi.fn().mockResolvedValue(undefined);

    const wrapper = mountModal(pinia);
    await flushPromises();

    expect(wrapper.findAll('.review-item__del')).toHaveLength(1);
    expect(wrapper.find('.review-form').exists()).toBe(false);
    // подсказка про вход не показывается — пользователь вошёл
    expect(wrapper.text()).not.toContain('Войдите');
  });

  it('Esc и клик по фону закрывают модалку', async () => {
    const { pinia } = setup();
    const wrapper = mountModal(pinia);
    await flushPromises();

    await wrapper.find('.modal-backdrop').trigger('keydown.esc');
    expect(wrapper.emitted('close')).toHaveLength(1);

    await wrapper.find('.modal-backdrop').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(2);
  });
});
