/** BookingModal: карта мест, чипы сеансов, сабмит брони и цена сеанса (Тарификатор). Аншлаг/лист ожидания и Привратник-429 — в BookingModal-waitlist.spec.ts */
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Booking, Movie, SeatMap } from '@/shared/api/types';
import { api, ApiError, saveAuth } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useBookingsStore } from '@/entities/booking/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
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

    // демо: флаг включён — главная кнопка «Купить», старый поток младшей
    const submit = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    expect(submit.text()).toBe('Купить за 400 ₽');
    expect(submit.attributes('disabled')).toBeUndefined();
    const ghosts = wrapper.findAll('.modal__actions .btn--ghost');
    expect(ghosts.map((b) => b.text())).toEqual(['Отмена', 'Забронировать']);
  });

  it('пока мгновенная покупка в полёте — обе кнопки заморожены, спиннер на нажатой', async () => {
    const { wrapper } = mountModal();
    const bookingsStore = useBookingsStore();
    let resolveCheckout!: (booking: Booking) => void;
    bookingsStore.checkout = vi.fn(
      () => new Promise<Booking>((resolve) => (resolveCheckout = resolve)),
    );

    await wrapper.find('input.field__input').setValue('Дима');
    await wrapper
      .findAll('button.hall__seat:not([disabled])')[0]
      .trigger('click');

    const buy = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    const book = wrapper
      .findAll('.modal__actions .btn--ghost')
      .find((b) => b.text() === 'Забронировать')!;
    void buy.trigger('click'); // не ждём — checkout висит в pending
    await nextTick();

    expect(buy.classes()).toContain('btn--loading');
    expect(buy.find('.spinner').exists()).toBe(true);
    expect(buy.attributes('aria-busy')).toBe('true');
    expect(buy.attributes('disabled')).toBeDefined();
    expect(buy.text()).toContain('Отправляем');
    // младшая кнопка не даёт запустить второй поток на том же выборе
    expect(book.attributes('disabled')).toBeDefined();

    resolveCheckout({
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
      status: 'PENDING', // мгновенный чекаут: платёж уже запущен
      expiresAt: null,
      message: null,
      processedBy: null,
      processedAt: null,
      createdAt: '2026-11-08T10:00:00Z',
    });
    await flushPromises();

    expect(bookingsStore.checkout).toHaveBeenCalledWith({
      sessionId: 's-1',
      customerName: 'Дима', // демо спрашивает имя — уходит в чекаут
      seats: ['1-2'],
    });
    expect(buy.classes()).not.toContain('btn--loading');
    expect(buy.find('.spinner').exists()).toBe(false);
    expect(wrapper.emitted('created')).toHaveLength(1);
  });

  it('пока бронь создаётся (старый поток) — спиннер на младшей кнопке', async () => {
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

    const buy = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    const book = wrapper
      .findAll('.modal__actions .btn--ghost')
      .find((b) => b.text() === 'Забронировать')!;
    void book.trigger('click');
    await nextTick();

    expect(book.classes()).toContain('btn--loading');
    expect(book.text()).toContain('Отправляем');
    expect(book.attributes('disabled')).toBeDefined();
    expect(buy.attributes('disabled')).toBeDefined(); // главная тоже заморожена

    resolveCreate({
      id: 'b-2',
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
    });
    await flushPromises();

    expect(bookingsStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-1', seats: ['1-2'] }),
    );
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
    // старый поток — младшая кнопка «Забронировать»
    await wrapper
      .findAll('.modal__actions .btn--ghost')
      .find((b) => b.text() === 'Забронировать')!
      .trigger('click');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-1', seats: ['1-2'] }),
    );
  });
});

describe('BookingModal: цена сеанса (Тарификатор)', () => {
  it('квот с факторами: чипы раскладки, зачёркнутая база и итог от цены места', async () => {
    const { wrapper, moviesStore } = mountModal();
    moviesStore.quote = {
      sessionId: 's-1',
      sessionAt: movie.sessions[0].startsAt,
      basePriceRub: 400,
      priceRub: 480,
      factors: [{ code: 'evening', label: 'вечерний прайм +20%', percent: 20 }],
      dynamic: true,
    };
    await nextTick();

    const price = wrapper.find('[data-testid="session-price"]');
    expect(price.text()).toContain('480');
    expect(price.text()).toContain('400'); // зачёркнутая база
    expect(price.text()).toContain('вечерний прайм +20%');
    expect(price.find('.price__fallback').exists()).toBe(false);

    // итог = цена места × выбор: 480 × 2
    const free = wrapper.findAll('button.hall__seat:not([disabled])');
    await free[0].trigger('click');
    await free[2].trigger('click');
    expect(wrapper.find('.modal__total').text()).toContain('960');
  });

  it('скидочный фактор — зелёный чип, надбавка — янтарный', async () => {
    const { wrapper, moviesStore } = mountModal();
    moviesStore.quote = {
      sessionId: 's-1',
      sessionAt: movie.sessions[0].startsAt,
      basePriceRub: 400,
      priceRub: 288,
      factors: [
        { code: 'morning', label: 'утренний сеанс −20%', percent: -20 },
        { code: 'demand_low', label: 'зал почти пуст −10%', percent: -10 },
      ],
      dynamic: true,
    };
    await nextTick();

    expect(wrapper.findAll('.price__factor--down')).toHaveLength(2);
    expect(wrapper.findAll('.price__factor--up')).toHaveLength(0);
  });

  it('dynamic=false — бейдж «базовая цена», итог от базы афиши', async () => {
    const { wrapper, moviesStore } = mountModal();
    moviesStore.quote = {
      sessionId: 's-1',
      sessionAt: movie.sessions[0].startsAt,
      basePriceRub: 400,
      priceRub: 400,
      factors: [],
      dynamic: false,
    };
    await nextTick();

    expect(wrapper.find('.price__fallback').exists()).toBe(true);
    const free = wrapper.findAll('button.hall__seat:not([disabled])');
    await free[0].trigger('click');
    expect(wrapper.find('.modal__total').text()).toContain('400');
  });

  it('квота нет (сеть умерла) — итог от базовой цены афиши', async () => {
    const { wrapper, moviesStore } = mountModal();
    moviesStore.quote = null;
    await nextTick();

    const free = wrapper.findAll('button.hall__seat:not([disabled])');
    await free[0].trigger('click');
    await free[2].trigger('click');
    expect(wrapper.find('.modal__total').text()).toContain('800'); // 400 × 2
  });

  it('смена сеанса перезагружает квот', async () => {
    const { wrapper, moviesStore } = mountModal();
    const chips = wrapper.findAll('.session-chip');
    await chips[1].trigger('click'); // s-2
    expect(moviesStore.loadQuote).toHaveBeenCalledWith('s-2');
  });
});

describe('BookingModal: мгновенная покупка за флагом (live-вердикты)', () => {
  /** live-режим: карты в сторе, стрим и загрузки замоканы, сессия — опционально */
  function mountModalLive(opts?: { authed?: boolean }) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const appStore = useAppStore();
    const moviesStore = useMoviesStore();
    appStore.mode = 'live';
    moviesStore.loadSeats = vi.fn();
    moviesStore.loadQuote = vi.fn();
    moviesStore.startSeatStream = vi.fn();
    moviesStore.seatMap = seatMap;
    if (opts?.authed) {
      saveAuth('jwt-1', {
        id: 'u-1',
        email: 'anna@example.com',
        name: 'Анна',
        role: 'user',
        createdAt: '2026-01-01T00:00:00Z',
      });
    }
    const wrapper = mount(BookingModal, {
      props: { movie },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    return { wrapper, moviesStore };
  }

  const verdict = (enabled: boolean) =>
    Promise.resolve({
      key: 'checkout.new_flow',
      enabled,
      reason: enabled ? 'on' : 'flag_off',
    } as const);

  beforeEach(() => {
    localStorage.clear();
  });

  it('без входа кнопки мгновенной покупки нет — вердикт не спрашивается', async () => {
    const flagSpy = vi.spyOn(api, 'flag');
    const { wrapper } = mountModalLive(); // аноним
    await flushPromises();

    expect(flagSpy).not.toHaveBeenCalled(); // чекаут требует JWT — смысла нет
    const primary = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    expect(primary.text()).toBe('Выберите места'); // осталась одна главная
    expect(wrapper.text()).not.toContain('Купить');
    flagSpy.mockRestore();
  });

  it('вердикт on: главная — «Купить», чекаут уходит без имени (оно в JWT)', async () => {
    const flagSpy = vi
      .spyOn(api, 'flag')
      .mockReturnValue(verdict(true) as never);
    const { wrapper } = mountModalLive({ authed: true });
    const bookingsStore = useBookingsStore();
    bookingsStore.checkout = vi.fn().mockResolvedValue({ id: 'b-9' } as Booking);
    await flushPromises();

    await wrapper
      .findAll('button.hall__seat:not([disabled])')[0]
      .trigger('click');
    const buy = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    expect(buy.text()).toBe('Купить за 400 ₽');
    await buy.trigger('click');

    expect(bookingsStore.checkout).toHaveBeenCalledWith({
      sessionId: 's-1',
      seats: ['1-2'], // без customerName: live берёт имя из токена
    });
    expect(wrapper.emitted('created')).toHaveLength(1);
    flagSpy.mockRestore();
  });

  it('вердикт off (вне раскатки): мгновенной кнопки нет, старый поток целый', async () => {
    const flagSpy = vi
      .spyOn(api, 'flag')
      .mockReturnValue(verdict(false) as never);
    const { wrapper } = mountModalLive({ authed: true });
    await flushPromises();

    await wrapper
      .findAll('button.hall__seat:not([disabled])')[0]
      .trigger('click');
    const primary = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    expect(primary.text()).toBe('Забронировать');
    expect(wrapper.text()).not.toContain('Купить за');
    flagSpy.mockRestore();
  });

  it('403 featureDisabled: тумблер повернули после вердикта — кнопка прячется', async () => {
    const flagSpy = vi
      .spyOn(api, 'flag')
      .mockReturnValue(verdict(true) as never);
    const { wrapper } = mountModalLive({ authed: true });
    const bookingsStore = useBookingsStore();
    bookingsStore.checkout = vi.fn().mockRejectedValue(
      new ApiError(
        'HTTP 403',
        403,
        JSON.stringify({
          statusCode: 403,
          code: 'featureDisabled',
          flag: 'checkout.new_flow',
          reason: 'kill_switch',
        }),
      ),
    );
    await flushPromises();

    await wrapper
      .findAll('button.hall__seat:not([disabled])')[0]
      .trigger('click');
    await wrapper.find('.modal__actions .btn:not(.btn--ghost)').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('забронируйте обычным способом');
    expect(wrapper.text()).not.toContain('Купить за'); // кнопка ушла
    // старый поток остался доступным
    expect(
      wrapper
        .findAll('.modal__actions .btn')
        .some((b) => b.text() === 'Забронировать'),
    ).toBe(true);
    flagSpy.mockRestore();
  });

  it('сбой вердикта (сеть): кнопки нет — fail-safe, как у гварда', async () => {
    const flagSpy = vi
      .spyOn(api, 'flag')
      .mockRejectedValue(new Error('HTTP 502') as never);
    const { wrapper } = mountModalLive({ authed: true });
    await flushPromises();

    expect(wrapper.text()).not.toContain('Купить за');
    flagSpy.mockRestore();
  });
});

describe('BookingModal: промо и бонусы мгновенной покупки', () => {
  /** live + вердикт on: поля оплаты видны, баланс замокан */
  function mountModalWithBalance(balance: number) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const appStore = useAppStore();
    const moviesStore = useMoviesStore();
    appStore.mode = 'live';
    moviesStore.loadSeats = vi.fn();
    moviesStore.loadQuote = vi.fn();
    moviesStore.startSeatStream = vi.fn();
    moviesStore.seatMap = seatMap;
    saveAuth('jwt-1', {
      id: 'u-1',
      email: 'anna@example.com',
      name: 'Анна',
      role: 'user',
      createdAt: '2026-01-01T00:00:00Z',
    });
    const flagSpy = vi
      .spyOn(api, 'flag')
      .mockResolvedValue({ key: 'checkout.new_flow', enabled: true, reason: 'on' } as never);
    const balanceSpy = vi
      .spyOn(api, 'myBonuses')
      .mockResolvedValue({ balance, transactions: [] } as never);
    const wrapper = mount(BookingModal, {
      props: { movie },
      global: { plugins: [pinia], stubs: { Teleport: true } },
    });
    return { wrapper, flagSpy, balanceSpy };
  }

  /** два свободных места: 1-2 и 1-4 — сумма 800 ₽ */
  async function pickTwoSeats(wrapper: ReturnType<typeof mountModalWithBalance>['wrapper']) {
    const free = wrapper.findAll('button.hall__seat:not([disabled])');
    await free[0].trigger('click'); // 1-2
    await free[2].trigger('click'); // 1-4
  }

  beforeEach(() => {
    localStorage.clear();
  });

  it('промокод и бонусы летят в чекаут; кнопка пересчитывает сумму списанием', async () => {
    const { wrapper, flagSpy, balanceSpy } = mountModalWithBalance(300);
    const bookingsStore = useBookingsStore();
    bookingsStore.checkout = vi.fn().mockResolvedValue({ id: 'b-9' } as Booking);
    await flushPromises();

    await pickTwoSeats(wrapper); // 800 ₽
    // блок бонусов виден: потолок = min(половина суммы, баланс) = 300
    expect(wrapper.find('.pay-bonus').exists()).toBe(true);
    expect(wrapper.text()).toContain('максимум 300');
    await wrapper.find('.modal__pay input[type="text"]').setValue('CINE10');
    await wrapper.find('.pay-bonus__toggle input[type="checkbox"]').setValue(true);
    // включили бонусы — дефолт максимум, кнопка пересчиталась: 800 − 300
    const buy = wrapper.find('.modal__actions .btn:not(.btn--ghost)');
    expect(buy.text()).toBe('Купить за 500 ₽');
    await buy.trigger('click');

    expect(bookingsStore.checkout).toHaveBeenCalledWith({
      sessionId: 's-1',
      seats: ['1-2', '1-4'],
      promoCode: 'CINE10',
      useBonuses: 300,
    });
    flagSpy.mockRestore();
    balanceSpy.mockRestore();
  });

  it('пустой промо и выключенные бонусы в payload не попадают', async () => {
    const { wrapper, flagSpy, balanceSpy } = mountModalWithBalance(300);
    const bookingsStore = useBookingsStore();
    bookingsStore.checkout = vi.fn().mockResolvedValue({ id: 'b-9' } as Booking);
    await flushPromises();

    await pickTwoSeats(wrapper);
    await wrapper.find('.modal__actions .btn:not(.btn--ghost)').trigger('click');

    expect(bookingsStore.checkout).toHaveBeenCalledWith({
      sessionId: 's-1',
      seats: ['1-2', '1-4'],
    });
    flagSpy.mockRestore();
    balanceSpy.mockRestore();
  });

  it('кривой формат промокода — ошибка до отправки, чекаута нет', async () => {
    const { wrapper, flagSpy, balanceSpy } = mountModalWithBalance(300);
    const bookingsStore = useBookingsStore();
    bookingsStore.checkout = vi.fn();
    await flushPromises();

    await pickTwoSeats(wrapper);
    await wrapper.find('.modal__pay input[type="text"]').setValue('xx');
    await wrapper.find('.modal__actions .btn:not(.btn--ghost)').trigger('click');

    expect(bookingsStore.checkout).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Код: 3–32 символа');
    flagSpy.mockRestore();
    balanceSpy.mockRestore();
  });

  it('отказ промо: подсказка про созданную бронь, «мои» тянутся', async () => {
    const { wrapper, flagSpy, balanceSpy } = mountModalWithBalance(300);
    const bookingsStore = useBookingsStore();
    bookingsStore.checkout = vi.fn().mockRejectedValue(
      new ApiError(
        'HTTP 409',
        409,
        JSON.stringify({ statusCode: 409, code: 'promoExhausted' }),
      ),
    );
    bookingsStore.refreshMine = vi.fn().mockResolvedValue(undefined);
    await flushPromises();

    await pickTwoSeats(wrapper);
    await wrapper.find('.modal__pay input[type="text"]').setValue('CINE10');
    await wrapper.find('.modal__actions .btn:not(.btn--ghost)').trigger('click');
    await flushPromises();

    // отказ оплаты не прячет бронь: подсказываем путь к дооплате
    expect(wrapper.text()).toContain('Лимит активаций промокода исчерпан');
    expect(wrapper.text()).toContain('дооплатите её в «Моих билетах»');
    expect(bookingsStore.refreshMine).toHaveBeenCalledTimes(1);
    // кнопка мгновенной покупки на месте — фича не при чём, не прошёл код
    expect(wrapper.text()).toContain('Купить за');
    flagSpy.mockRestore();
    balanceSpy.mockRestore();
  });

  it('отказ бонусов: подсказка, счёт освежен и ввод зажат по потолку', async () => {
    const { wrapper, flagSpy, balanceSpy } = mountModalWithBalance(1000);
    // первый баланс 1000 → потолок 400; после отказа сервер скажет 100
    balanceSpy.mockResolvedValue({ balance: 100, transactions: [] } as never);
    const bookingsStore = useBookingsStore();
    bookingsStore.checkout = vi.fn().mockRejectedValue(
      new ApiError(
        'HTTP 409',
        409,
        JSON.stringify({ statusCode: 409, code: 'bonusInsufficient' }),
      ),
    );
    bookingsStore.refreshMine = vi.fn().mockResolvedValue(undefined);
    await flushPromises();

    await pickTwoSeats(wrapper); // 800 ₽
    await wrapper.find('.pay-bonus__toggle input[type="checkbox"]').setValue(true);
    await wrapper.find('.modal__actions .btn:not(.btn--ghost)').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Не хватает бонусов на счету');
    expect(wrapper.text()).toContain('дооплатите её в «Моих билетах»');
    // баланс перечитан и ввод зажат по новому потолку: min(400, 100) = 100
    expect(balanceSpy).toHaveBeenCalledTimes(2);
    expect(
      (wrapper.find('.pay-bonus__input').element as HTMLInputElement).value,
    ).toBe('100');
    flagSpy.mockRestore();
    balanceSpy.mockRestore();
  });

  it('без мест блок оплаты не показывается', async () => {
    const { wrapper, flagSpy, balanceSpy } = mountModalWithBalance(300);
    await flushPromises();

    expect(wrapper.find('.modal__pay').exists()).toBe(false);
    flagSpy.mockRestore();
    balanceSpy.mockRestore();
  });
});
