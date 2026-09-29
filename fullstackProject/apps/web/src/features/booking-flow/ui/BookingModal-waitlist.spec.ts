/** BookingModal: аншлаг — лист ожидания, живая карта зала и Привратник — лимит броней (429). Ядро и Тарификатор — в BookingModal.spec.ts. Самодостаточен: свои копии фикстур и маунтов. */
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Booking, Movie, MyWaitlistEntry, SeatMap } from '@/shared/api/types';
import { ApiError } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useBookingsStore } from '@/entities/booking/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useWaitlistStore } from '@/entities/waitlist/model/store';
import BookingModal from '@/features/booking-flow/ui/BookingModal.vue';

const movie: Movie = {
  id: 'm-1',
  title: 'Рекурсия',
  description: 'Фильм о вложенных снах.',
  genre: 'хоррор',
  genreIcon: '👻',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  ratingAvg: 4.5,
  ratingCount: 2,
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
  moviesStore.loadQuote = vi.fn();
  moviesStore.seatMap = seatMap;

  const wrapper = mount(BookingModal, {
    props: { movie },
    global: { plugins: [pinia], stubs: { Teleport: true } },
  });
  return { wrapper, moviesStore };
}

/** аншлаг: зал 3×4 полон, вместо карты мест — CTA листа ожидания */
function mountFullModal(entry?: Partial<MyWaitlistEntry>) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const appStore = useAppStore();
  const moviesStore = useMoviesStore();
  const waitlistStore = useWaitlistStore();
  appStore.mode = 'demo';
  moviesStore.loadSeats = vi.fn();
  moviesStore.loadQuote = vi.fn();
  moviesStore.seatMap = {
    ...seatMap,
    occupied: [
      '1-1', '1-2', '1-3', '1-4',
      '2-1', '2-2', '2-3', '2-4',
      '3-1', '3-2', '3-3', '3-4',
    ],
    free: 0,
  };
  waitlistStore.join = vi.fn(async () => true);
  waitlistStore.leave = vi.fn(async () => undefined);
  if (entry) {
    waitlistStore.entries = [
      {
        id: 'w-1',
        sessionId: 's-1',
        userId: 'demo-guest',
        status: 'WAITING',
        position: 1,
        queuedAt: '2026-09-21T10:00:00Z',
        notifiedAt: null,
        createdAt: '2026-09-21T10:00:00Z',
        movieId: 'm-1',
        movieTitle: 'Рекурсия',
        hall: 'IMAX',
        startsAt: new Date(2030, 0, 10, 19, 0).toISOString(),
        ...entry,
      },
    ];
  }

  const wrapper = mount(BookingModal, {
    props: { movie },
    global: { plugins: [pinia], stubs: { Teleport: true } },
  });
  return { wrapper, moviesStore, waitlistStore };
}

beforeEach(() => {
  localStorage.clear();
});

describe('BookingModal: аншлаг — лист ожидания', () => {
  it('полный зал: карты мест нет, вместо неё CTA «Сообщить о свободном месте»', () => {
    const { wrapper } = mountFullModal();

    expect(wrapper.findAll('button.hall__seat')).toHaveLength(0);
    expect(wrapper.text()).toContain('занято 12 из 12');
    const cta = wrapper.find('.waitlist-cta');
    expect(cta.text()).toContain('Все места заняты');
    expect(cta.find('.btn').text()).toContain('Сообщить о свободном месте');
  });

  it('клик по CTA — join с id выбранного сеанса', async () => {
    const { wrapper, waitlistStore } = mountFullModal();

    await wrapper.find('.waitlist-cta .btn').trigger('click');

    expect(waitlistStore.join).toHaveBeenCalledWith('s-1');
  });

  it('в очереди: позиция и выход из очереди', async () => {
    const { wrapper, waitlistStore } = mountFullModal({
      status: 'WAITING',
      position: 2,
    });

    const cta = wrapper.find('.waitlist-cta');
    expect(cta.text()).toContain('Вы в очереди');
    expect(cta.text()).toContain('позиция 2');
    expect(cta.text()).not.toContain('Сообщить о свободном месте');

    await cta.find('.btn').trigger('click');
    expect(waitlistStore.leave).toHaveBeenCalledWith('s-1');
  });

  it('NOTIFIED: «Место освобождалось», повторный join и обновление карты', async () => {
    const { wrapper, moviesStore, waitlistStore } = mountFullModal({
      status: 'NOTIFIED',
      position: null,
      notifiedAt: '2026-09-21T10:05:00Z',
    });

    const cta = wrapper.find('.waitlist-cta');
    expect(cta.text()).toContain('Место освобождалось — успей!');
    expect(cta.text()).toContain('честной гонке');

    const buttons = cta.findAll('.btn');
    await buttons[0].trigger('click'); // «Сообщить…» = встать заново
    expect(waitlistStore.join).toHaveBeenCalledWith('s-1');

    await buttons[1].trigger('click'); // «Обновить карту»
    expect(moviesStore.loadSeats).toHaveBeenCalledWith('s-1');
  });

  it('живая карта: место, занятое при мне, выпадает из выбора с подсказкой', async () => {
    const { wrapper, moviesStore } = mountModal();

    // «первый взгляд» инициализирует дифф (в live это делает loadSeats)
    moviesStore.seatMap = { ...seatMap };
    await nextTick();

    // первый свободный сеанс 3×4 (заняты 1-1 и 2-2) — это 1-2
    await wrapper.findAll('button.hall__seat:not([disabled])')[0].trigger('click');
    expect(wrapper.findAll('.seat-chip')).toHaveLength(1);

    // чужая покупка прилетает кадром живой карты
    moviesStore.seatMap = {
      ...seatMap,
      occupied: ['1-1', '2-2', '1-2'],
      free: 9,
    };
    await nextTick();

    expect(wrapper.findAll('.seat-chip')).toHaveLength(0);
    expect(wrapper.text()).toContain('Место 1-2 только что заняли');
    // и кнопка «Выберите места» снова подсказывает пустой выбор
    expect(wrapper.text()).toContain('Выберите места');
  });

  it('открытие модалки стартует поток живой карты, закрытие — стоп', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const appStore = useAppStore();
    const moviesStore = useMoviesStore();
    appStore.mode = 'demo';
    moviesStore.loadSeats = vi.fn();
    moviesStore.seatMap = seatMap;
    const start = (moviesStore.startSeatStream = vi.fn());
    const stop = (moviesStore.stopSeatStream = vi.fn());

    const wrapper = mount(BookingModal, {
      props: { movie },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('s-1', expect.any(Function));

    await wrapper.setProps({ movie: null });
    expect(stop).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});

describe('BookingModal: Привратник — лимит броней (429)', () => {
  /**
   * Как mountModal, но без живой карты: фейковые таймеры отсчёта не должны
   * раскачивать демо-«зрителей» — кулдаун тестируется в изоляции.
   */
  function mountNoStream() {
    const pinia = createPinia();
    setActivePinia(pinia);
    const appStore = useAppStore();
    const moviesStore = useMoviesStore();
    appStore.mode = 'demo';
    moviesStore.loadSeats = vi.fn();
    moviesStore.loadQuote = vi.fn();
    moviesStore.seatMap = seatMap;
    moviesStore.startSeatStream = vi.fn();
    moviesStore.stopSeatStream = vi.fn();

    const wrapper = mount(BookingModal, {
      props: { movie },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    return { wrapper, moviesStore };
  }

  /** тело 429 Привратника — зеркально RateLimitGuard API и демо-движку */
  const rateLimited = (retryAfterSec: number) =>
    new ApiError(
      'HTTP 429',
      429,
      JSON.stringify({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Слишком часто — попробуйте позже',
        code: 'rateLimited',
        retryAfterSec,
      }),
    );

  /** успешная бронь для mockResolvedValue */
  const created: Booking = {
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
    promoCode: null,
    discountRub: null,
    bonusSpent: null,
    status: 'PENDING_PAYMENT',
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    message: null,
    processedBy: null,
    processedAt: null,
    createdAt: '2026-09-12T10:00:00Z',
  };

  /** демо спрашивает имя: заполняем, выбираем место, жмём бронь */
  async function attempt(wrapper: ReturnType<typeof mountNoStream>['wrapper']) {
    await wrapper.find('input.field__input').setValue('Дима');
    await wrapper.findAll('button.hall__seat:not([disabled])')[0].trigger('click');
    await wrapper.find('.modal__actions .btn:not(.btn--ghost)').trigger('click');
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('429 замораживает кнопку на retryAfterSec, отсчёт — прямо в подписи', async () => {
    const { wrapper } = mountNoStream();
    const bookingsStore = useBookingsStore();
    bookingsStore.create = vi.fn().mockRejectedValue(rateLimited(7));

    await attempt(wrapper);
    const submit = wrapper.find('.modal__actions .btn:not(.btn--ghost)');

    expect(wrapper.text()).toContain('Слишком много броней');
    expect(wrapper.text()).toContain('подождите 7 с');
    expect(submit.attributes('disabled')).toBeDefined();
    expect(submit.text()).toContain('Подождите 7');

    vi.advanceTimersByTime(3000);
    await nextTick();
    expect(submit.text()).toContain('Подождите 4');

    vi.advanceTimersByTime(4000);
    await nextTick();
    // кулдаун кончился — выбор мест жив, кнопка снова «Забронировать»
    expect(submit.attributes('disabled')).toBeUndefined();
    expect(submit.text()).toContain('Забронировать');
  });

  it('по окончании кулдауна бронь создаётся повторной отправкой', async () => {
    const { wrapper } = mountNoStream();
    const bookingsStore = useBookingsStore();
    const create = vi.fn()
      .mockRejectedValueOnce(rateLimited(5))
      .mockResolvedValue(created);
    bookingsStore.create = create;

    await attempt(wrapper);
    vi.advanceTimersByTime(5000);
    await nextTick();

    await wrapper.find('.modal__actions .btn:not(.btn--ghost)').trigger('click');

    expect(create).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('created')).toHaveLength(1);
  });

  it('429 без кода rateLimited — обычная ошибка, кнопка не замораживается', async () => {
    const { wrapper } = mountNoStream();
    const bookingsStore = useBookingsStore();
    bookingsStore.create = vi.fn().mockRejectedValue(
      new ApiError('HTTP 429', 429, JSON.stringify({ message: 'Slow down' })),
    );

    await attempt(wrapper);
    const submit = wrapper.find('.modal__actions .btn:not(.btn--ghost)');

    expect(submit.text()).not.toContain('Подождите');
    expect(submit.attributes('disabled')).toBeUndefined();
    // общий текст ветки — конструктор ApiError, не тело
    expect(wrapper.text()).toContain('HTTP 429');
  });
});
