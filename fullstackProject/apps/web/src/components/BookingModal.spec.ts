import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, Movie, SeatMap } from '../api/types';
import { useAppStore } from '../stores/app';
import { useBookingsStore } from '../stores/bookings';
import { useMoviesStore } from '../stores/movies';
import BookingModal from './BookingModal.vue';

const movie: Movie = {
  id: 'm-1',
  title: 'Рекурсия',
  description: 'Фильм о вложенных снах.',
  genre: 'хоррор',
  genreIcon: '👻',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  sessions: [
    { id: 's-1', hall: 'IMAX', startsAt: new Date(2030, 0, 10, 19, 0).toISOString() },
    { id: 's-2', hall: 'Красный', startsAt: new Date(2030, 0, 11, 21, 0).toISOString() },
    // прошедший сеанс — не должен попасть в чипы
    { id: 's-past', hall: 'Красный', startsAt: new Date(2020, 0, 1, 10, 0).toISOString() },
  ],
};

/** 3 ряда по 4 места, заняты 1-1 и 2-2 */
const seatMap: SeatMap = {
  sessionId: 's-1',
  layout: { rows: 3, seatsPerRow: 4 },
  occupied: ['1-1', '2-2'],
  free: 10,
};

/** демо-режим (спрашиваем имя), карта зала уже в сторе, loadSeats замокан */
function mountModal() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const appStore = useAppStore();
  const moviesStore = useMoviesStore();
  appStore.mode = 'demo';
  moviesStore.loadSeats = vi.fn();
  moviesStore.seatMap = seatMap;

  const wrapper = mount(BookingModal, {
    props: { movie },
    global: { plugins: [pinia], stubs: { Teleport: true } },
  });
  return { wrapper, moviesStore };
}

beforeEach(() => {
  localStorage.clear();
});

describe('BookingModal', () => {
  it('показывает занятость зала по карте мест', () => {
    const { wrapper } = mountModal();

    expect(wrapper.text()).toContain('занято 2 из 12');
    expect(wrapper.find('.occupancy__fill').attributes('style')).toContain(
      'width: 17%',
    );
  });

  it('до выбора мест кнопка подсказывает и выключена', () => {
    const { wrapper } = mountModal();

    const submit = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    expect(submit.text()).toBe('Выберите места');
    expect(submit.attributes('disabled')).toBeDefined();
  });

  it('выбранные места — чипами; клик по чипу снимает место', async () => {
    const { wrapper } = mountModal();

    const free = wrapper.findAll('button.hall__seat:not([disabled])');
    await free[0].trigger('click'); // 1-2
    await free[2].trigger('click'); // 1-4
    expect(wrapper.findAll('.seat-chip')).toHaveLength(2);

    await wrapper.findAll('.seat-chip')[0].trigger('click'); // снять 1-2
    const chips = wrapper.findAll('.seat-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].text()).toContain('1-4');

    const submit = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    expect(submit.text()).toBe('Забронировать');
    expect(submit.attributes('disabled')).toBeUndefined();
  });

  it('пока бронь создаётся — кнопка крутит спиннер и выключена', async () => {
    const { wrapper } = mountModal();
    const bookingsStore = useBookingsStore();
    let resolveCreate!: (booking: Booking) => void;
    bookingsStore.create = vi.fn(
      () => new Promise<Booking>((resolve) => (resolveCreate = resolve)),
    );

    await wrapper.find('input.field__input').setValue('Дима');
    await wrapper
      .findAll('button.hall__seat:not([disabled])')[0]
      .trigger('click');

    const submit = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    void submit.trigger('click'); // не ждём — create висит в pending
    await nextTick();

    expect(submit.classes()).toContain('btn--loading');
    expect(submit.find('.spinner').exists()).toBe(true);
    expect(submit.attributes('aria-busy')).toBe('true');
    expect(submit.attributes('disabled')).toBeDefined();
    expect(submit.text()).toContain('Отправляем');

    resolveCreate({
      id: 'b-1',
      movieId: 'm-1',
      movieTitle: 'Рекурсия',
      movieHue: 275,
      movieGenreIcon: '👻',
      sessionId: 's-1',
      sessionAt: new Date(2030, 0, 10, 19, 0).toISOString(),
      hall: 'IMAX',
      customerName: 'Дима',
      userId: null,
      seats: ['1-2'],
      totalRub: 400,
      status: 'PENDING',
      message: null,
      processedBy: null,
      processedAt: null,
      createdAt: '2026-09-12T10:00:00Z',
    });
    await flushPromises();

    expect(submit.classes()).not.toContain('btn--loading');
    expect(submit.find('.spinner').exists()).toBe(false);
    expect(wrapper.emitted('created')).toHaveLength(1);
  });

  it('будущие сеансы — чипами; дефолт — ближайший, прошедших нет', async () => {
    const { wrapper, moviesStore } = mountModal();

    const chips = wrapper.findAll('.session-chip');
    expect(chips).toHaveLength(2); // s-past отфильтрован
    expect(chips[0].text()).toContain('IMAX');
    expect(chips[0].classes()).toContain('session-chip--active');
    // карта зала загружена именно для дефолтного сеанса
    const loadSeats = moviesStore.loadSeats as ReturnType<typeof vi.fn>;
    expect(loadSeats.mock.calls[0]?.[0]).toBe('s-1');
  });

  it('смена сеанса сбрасывает выбор мест и перезагружает карту', async () => {
    const { wrapper, moviesStore } = mountModal();
    const loadSeats = moviesStore.loadSeats as ReturnType<typeof vi.fn>;
    loadSeats.mockClear();

    const free = wrapper.findAll('button.hall__seat:not([disabled])');
    await free[0].trigger('click'); // выбрали место в первом сеансе
    expect(wrapper.findAll('.seat-chip')).toHaveLength(1);

    const second = wrapper.findAll('.session-chip')[1];
    await second.trigger('click');

    // выбор сброшен, карта перезагружена с id второго сеанса
    expect(wrapper.findAll('.seat-chip')).toHaveLength(0);
    expect(loadSeats).toHaveBeenCalledWith('s-2');
    // кнопка снова «Выберите места»
    const submit = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    expect(submit.attributes('disabled')).toBeDefined();
  });

  it('бронь уходит с id выбранного сеанса', async () => {
    const { wrapper } = mountModal();
    const bookingsStore = useBookingsStore();
    const create = vi.fn();
    bookingsStore.create = create;

    await wrapper.find('input.field__input').setValue('Дима');
    await wrapper.findAll('button.hall__seat:not([disabled])')[0].trigger('click');
    await wrapper.find('.modal__actions .btn:not(.btn--ghost)').trigger('click');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-1', seats: ['1-2'] }),
    );
  });
});
