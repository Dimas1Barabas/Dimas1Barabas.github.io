import type {
  Booking,
  BookingStats,
  CreateBookingPayload,
  CreateReviewPayload,
  Movie,
  MovieSession,
  Review,
  SeatMap,
} from './types';
import { ApiError } from './client';
import {
  HALL_CAPACITY,
  HALL_ROWS,
  HALL_SEATS_PER_ROW,
  allSeatCodes,
  compareSeats,
  isValidSeat,
} from '../utils/hall';

/**
 * Демо-режим: браузерная симуляция бэкенда для GitHub Pages.
 * Повторяет поведение реального стенда:
 *  - фильмы с расписанием сеансов (зал + время) и пометкой источника
 *    «кэш»/«БД» (как Redis-кэш API);
 *  - карта занятости зала сеанса, детерминированно посеянная при первом
 *    заходе (в живом стенде места занимают брони в Postgres);
 *  - созданная бронь рождается в PENDING_PAYMENT и держит выбранные места;
 *    конфликт мест — 409, как уникальный констрейнт (session_id, seat)
 *    в API; одно место в разных сеансах одного фильма — независимо;
 *  - pay() запускает «воркера»: через 1,2–2,8 с (те же тайминги и
 *    вероятность успеха, что у Go ticket-worker) выносится вердикт;
 *    при FAILED места освобождаются;
 *  - неоплаченная за окно оплаты бронь истекает: EXPIRED, места свободны
 *    (в живом стенде это TTL wait-очереди RabbitMQ → booking.expired);
 *  - сага отмены: CONFIRMED → CANCELLING → возврат 0,8–1,6 с с той же
 *    вероятностью успеха, что у воркера; места освобождаются при успехе.
 *  - отмена неоплаченной — сразу CANCELLED без воркера.
 *  - отзывы: сид-отзывы «других зрителей», право гостя на отзыв — своя
 *    CONFIRMED-бронь (403 иначе), дубль — 409, агрегат рейтинга на фильме
 *    пересчитывается сразу; как reviews-модуль API.
 */

const SUCCESS_RATE = 0.9;
const MIN_MS = 1200;
const MAX_MS = 2800;
/** сага отмены — те же тайминги/вероятность, что у возврата в Go-воркере */
const REFUND_SUCCESS_RATE = 0.9;
const REFUND_MIN_MS = 800;
const REFUND_MAX_MS = 1600;
/** окно оплаты демо — паритет с PAYMENT_TIMEOUT_MS docker-стенда (2 мин) */
export const DEMO_PAYMENT_TIMEOUT_MS = 120_000;

function inDays(days: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** сеансы демо-фильма: «завтра» обязателен, чтобы демо не пустовало ночью */
function sessionsOf(
  movieId: string,
  defs: [days: number, hour: number, hall: string][],
): MovieSession[] {
  return defs.map(([days, hour, hall], i) => ({
    id: `${movieId}-s${i + 1}`,
    hall,
    startsAt: inDays(days, hour),
  }));
}

const DEMO_MOVIE_SEEDS: Omit<Movie, 'ratingAvg' | 'ratingCount'>[] = [
  {
    id: 'demo-milky-way',
    title: 'Млечный Путь: Операция «Туманность»',
    description:
      'Космофлот теряет связь с колонией Туманность. Экипаж разведчика «Скиталец» должен выяснить, что произошло, — и постараться не сойти с ума по дороге.',
    genre: 'фантастика',
    genreIcon: '🚀',
    durationMin: 132,
    priceRub: 450,
    hue: 220,
    sessions: sessionsOf('demo-milky-way', [
      [0, 19, 'IMAX'],
      [1, 12, 'Красный'],
      [2, 21, 'IMAX'],
    ]),
  },
  {
    id: 'demo-last-debug',
    title: 'Последний дебаг',
    description:
      'За сутки до релиза в проде плавает баг, который воспроизводится только у джуниора. Он ещё не знает: это не баг, а фича. Чужая.',
    genre: 'триллер',
    genreIcon: '🐞',
    durationMin: 98,
    priceRub: 320,
    hue: 160,
    sessions: sessionsOf('demo-last-debug', [
      [1, 21, 'Красный'],
      [3, 15, 'Красный'],
    ]),
  },
  {
    id: 'demo-cache-lady',
    title: 'Госпожа Кэш',
    description:
      'Богатейшая женщина города раздаёт долги незнакомцам. Но у каждого подарка есть цена, и она не измеряется деньгами.',
    genre: 'драма',
    genreIcon: '💰',
    durationMin: 141,
    priceRub: 380,
    hue: 330,
    sessions: sessionsOf('demo-cache-lady', [
      [0, 21, 'Красный'],
      [1, 18, 'IMAX'],
    ]),
  },
  {
    id: 'demo-recursion',
    title: 'Рекурсия',
    description:
      'Функция вызывает саму себя, чтобы пережить один и тот же вечер снова и снова. Рано или поздно стек переполнится.',
    genre: 'хоррор',
    genreIcon: '🌀',
    durationMin: 112,
    priceRub: 400,
    hue: 275,
    sessions: sessionsOf('demo-recursion', [
      [1, 23, 'IMAX'],
      [2, 22, 'Красный'],
    ]),
  },
  {
    id: 'demo-old-repo',
    title: 'Тайна старого репозитория',
    description:
      'Археолог находит заброшенный git-репозиторий 2009 года. В истории коммитов спрятано послание, которое меняет всё.',
    genre: 'приключения',
    genreIcon: '🗺️',
    durationMin: 124,
    priceRub: 350,
    hue: 30,
    sessions: sessionsOf('demo-old-repo', [
      [2, 15, 'Красный'],
      [3, 13, 'IMAX'],
      [3, 20, 'Красный'],
    ]),
  },
  {
    id: 'demo-49th-stream',
    title: 'Сорок девятый поток',
    description:
      'Год жизни курса веб-разработчиков: от «hello world» до оффера. Без монтажа, без купюр.',
    genre: 'документальный',
    genreIcon: '🎬',
    durationMin: 76,
    priceRub: 250,
    hue: 200,
    sessions: sessionsOf('demo-49th-stream', [
      [1, 14, 'Красный'],
      [2, 18, 'Красный'],
    ]),
  },
];

/** демо-афиша; рейтинг пересчитывается из отзывов при инициализации */
const DEMO_MOVIES: Movie[] = DEMO_MOVIE_SEEDS.map((m) => ({
  ...m,
  ratingAvg: 0,
  ratingCount: 0,
}));

/** «текущий пользователь» демо: авторизации нет, все его отзывы — гостевые */
const DEMO_GUEST_ID = 'demo-guest';
const DEMO_GUEST_NAME = 'Гость';

/** сид-отзывы: у части фильмов, от «других зрителей» */
const DEMO_REVIEW_SEEDS: {
  movieId: string;
  authorName: string;
  rating: number;
  text: string;
  daysAgo: number;
}[] = [
  {
    movieId: 'demo-milky-way',
    authorName: 'Ольга',
    rating: 5,
    text: 'Визуально щедро до неприличия, а финал не стыдный. Идём второй раз.',
    daysAgo: 3,
  },
  {
    movieId: 'demo-milky-way',
    authorName: 'Игорь',
    rating: 4,
    text: 'Затягивает как чёрная дыра, но темп во второй половине проседает.',
    daysAgo: 1,
  },
  {
    movieId: 'demo-last-debug',
    authorName: 'Катя',
    rating: 5,
    text: 'Хохотал весь зал, а я узнала свой продакшен в каждом кадре. Больно и точно.',
    daysAgo: 2,
  },
  {
    movieId: 'demo-recursion',
    authorName: 'Марк',
    rating: 4,
    text: 'Атмосфера давит правильно, но концовку угадал заранее. Всё равно мурашки.',
    daysAgo: 4,
  },
];

/** свежие объекты сид-отзывов (reset возвращает движок к ним) */
function seedReviews(): Review[] {
  return DEMO_REVIEW_SEEDS.map((s, i) => {
    const at = new Date(Date.now() - s.daysAgo * 86_400_000).toISOString();
    return {
      id: `demo-seed-r${i + 1}`,
      movieId: s.movieId,
      userId: `demo-seed-${i + 1}`,
      authorName: s.authorName,
      rating: s.rating,
      text: s.text,
      createdAt: at,
      updatedAt: at,
    };
  });
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `b-${Math.random().toString(36).slice(2, 10)}`;
}

type Listener = () => void;

class DemoEngine {
  private bookings: Booking[] = [];
  /** отзывы всех фильмов; «гость демо» — как user из JWT в live-режиме */
  private reviews: Review[] = seedReviews();
  private listeners = new Set<Listener>();
  private firstLoad = true;
  /** sessionId → занятые места (посев ленивый, при первом обращении) */
  private occupied = new Map<string, Set<string>>();
  /** bookingId → таймер экспирации неоплаченной брони (wait-очередь демо) */
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    // стартовые агрегаты рейтинга — из сид-отзывов (как recompute в tx API)
    DEMO_MOVIES.forEach((m) => this.recomputeMovie(m.id));
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }

  /** сброс состояния (тесты) */
  reset(): void {
    this.expiryTimers.forEach((t) => clearTimeout(t));
    this.expiryTimers.clear();
    this.bookings = [];
    this.occupied.clear();
    this.reviews = seedReviews();
    DEMO_MOVIES.forEach((m) => this.recomputeMovie(m.id));
    this.firstLoad = true;
  }

  movies(): { source: 'cache' | 'db'; data: Movie[] } {
    const source = this.firstLoad ? 'db' : 'cache';
    this.firstLoad = false;
    // копии: движок мутирует агрегаты рейтинга на месте — вне реактивности;
    // свежие идентичности заставляют карточки увидеть новый рейтинг
    // (сеансы не мутируются, ими можно делиться)
    return { source, data: DEMO_MOVIES.map((m) => ({ ...m })) };
  }

  /** сеанс по id: {фильм, сеанс} или null */
  private findSession(sessionId: string): {
    movie: Movie;
    session: MovieSession;
  } | null {
    for (const movie of DEMO_MOVIES) {
      const session = movie.sessions.find((s) => s.id === sessionId);
      if (session) return { movie, session };
    }
    return null;
  }

  /**
   * Детерминированный «посев» занятости: без случайностей, чтобы демо
   * выглядело живым, а тесты — стабильными (~20% зала занято).
   * Ключ — sessionId: у каждого сеанса свой посев.
   */
  private occupiedFor(sessionId: string): Set<string> {
    let seats = this.occupied.get(sessionId);
    if (!seats) {
      seats = new Set<string>();
      let h = 0;
      for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      for (const code of allSeatCodes()) {
        const [row, num] = code.split('-').map(Number);
        if ((h + row * 7 + num * 3) % 5 === 0) seats.add(code);
      }
      this.occupied.set(sessionId, seats);
    }
    return seats;
  }

  seatMap(sessionId: string): SeatMap {
    if (!this.findSession(sessionId)) {
      throw new Error('Сеанс не найден');
    }
    const occupied = [...this.occupiedFor(sessionId)].sort(compareSeats);
    return {
      sessionId,
      layout: { rows: HALL_ROWS, seatsPerRow: HALL_SEATS_PER_ROW },
      occupied,
      free: HALL_CAPACITY - occupied.length,
    };
  }

  list(): Booking[] {
    // новые брони unshift-ятся, поэтому массив уже отсортирован по дате
    return [...this.bookings];
  }

  stats(): BookingStats {
    const stats: BookingStats = {
      PENDING_PAYMENT: 0,
      PENDING: 0,
      CONFIRMED: 0,
      FAILED: 0,
      EXPIRED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    };
    for (const b of this.bookings) stats[b.status] += 1;
    return stats;
  }

  create(payload: CreateBookingPayload): Booking {
    const found = this.findSession(payload.sessionId);
    if (!found) throw new Error('Сеанс не найден');
    const { movie, session } = found;

    const seats = [...new Set(payload.seats)].sort(compareSeats);
    const invalid = seats.filter((s) => !isValidSeat(s));
    if (invalid.length > 0) {
      throw new ApiError('HTTP 400', 400, JSON.stringify({
        statusCode: 400,
        message: `Некорректные места: ${invalid.join(', ')}`,
      }));
    }

    // уникальный констрейнт (session_id, seat) в миниатюре
    const occupied = this.occupiedFor(session.id);
    const seatsTaken = seats.filter((s) => occupied.has(s));
    if (seatsTaken.length > 0) {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Места уже заняты: ${seatsTaken.join(', ')}`,
        seatsTaken,
      }));
    }
    seats.forEach((s) => occupied.add(s));

    const booking: Booking = {
      id: uuid(),
      movieId: movie.id,
      movieTitle: movie.title,
      movieHue: movie.hue,
      movieGenreIcon: movie.genreIcon,
      sessionId: session.id,
      sessionAt: session.startsAt,
      hall: session.hall,
      customerName: (payload.customerName ?? 'Гость').trim(),
      // демо-режим без токенов — владелец не привязывается (как брони до авторизации в API)
      userId: null,
      seats,
      totalRub: movie.priceRub * seats.length,
      status: 'PENDING_PAYMENT',
      expiresAt: new Date(Date.now() + DEMO_PAYMENT_TIMEOUT_MS).toISOString(),
      message: null,
      processedBy: null,
      processedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.bookings.unshift(booking);
    this.notify();

    // wait-очередь демо: по истечении окна оплаты неоплаченная бронь гасится
    this.expiryTimers.set(
      booking.id,
      setTimeout(() => {
        this.expiryTimers.delete(booking.id);
        if (booking.status !== 'PENDING_PAYMENT') return; // успел заплатить/отменить
        booking.status = 'EXPIRED';
        booking.message = 'Время оплаты истекло. Бронь отменена, места снова в продаже.';
        booking.processedBy = 'go-worker (демо)';
        booking.processedAt = new Date().toISOString();
        const occupiedSet = this.occupiedFor(booking.sessionId);
        booking.seats.forEach((s) => occupiedSet.delete(s));
        this.notify();
      }, DEMO_PAYMENT_TIMEOUT_MS),
    );

    return booking;
  }

  /**
   * Оплата: PENDING_PAYMENT → PENDING (условный переход — 409 иначе),
   * затем «воркер» проводит платёж. Миниатюра POST /bookings/:id/pay.
   */
  pay(id: string): Booking {
    const booking = this.bookings.find((b) => b.id === id);
    if (!booking) throw new Error('Бронь не найдена');
    if (booking.status !== 'PENDING_PAYMENT') {
      // как условный UPDATE … WHERE status='PENDING_PAYMENT' в API
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Оплатить можно только бронь, ждущую оплаты (сейчас: ${booking.status})`,
        status: booking.status,
      }));
    }
    const timer = this.expiryTimers.get(booking.id);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(booking.id);
    }
    booking.status = 'PENDING';
    this.notify();

    this.scheduleVerdict(booking);
    return booking;
  }

  /** «Go-воркер»: та же задержка и вероятность успеха, что в services/ticket-worker */
  private scheduleVerdict(booking: Booking): void {
    const delay = MIN_MS + Math.random() * (MAX_MS - MIN_MS);
    setTimeout(() => {
      const ok = Math.random() < SUCCESS_RATE;
      booking.status = ok ? 'CONFIRMED' : 'FAILED';
      booking.message = ok
        ? `Оплата ${booking.totalRub} ₽ прошла. Места ${booking.seats.join(', ')}. Приятного просмотра!`
        : `Платёж отклонён банком (код ${10 + Math.floor(Math.random() * 90)}). Бронь отменена, деньги не списаны.`;
      booking.processedBy = 'go-worker (демо)';
      booking.processedAt = new Date().toISOString();
      if (!ok) {
        // оплата не прошла — места возвращаются в продажу (как в API)
        const occupiedSet = this.occupiedFor(booking.sessionId);
        booking.seats.forEach((s) => occupiedSet.delete(s));
      }
      this.notify();
    }, delay);
  }

  /**
   * Отмена брони. Неоплаченная (PENDING_PAYMENT) закрывается сразу, без
   * «воркера» — возвращать нечего, места освобождаются немедленно.
   * Подтверждённая (CONFIRMED) запускает сагу: CANCELLING, затем «возврат
   * платежа» — те же тайминги и вероятность отказа, что у Go-воркера.
   * Успех освобождает места, отказ откатывает бронь в CONFIRMED.
   */
  cancel(id: string): Booking {
    const booking = this.bookings.find((b) => b.id === id);
    if (!booking) throw new Error('Бронь не найдена');
    if (booking.status === 'PENDING_PAYMENT') {
      const timer = this.expiryTimers.get(booking.id);
      if (timer) {
        clearTimeout(timer);
        this.expiryTimers.delete(booking.id);
      }
      booking.status = 'CANCELLED';
      booking.message = 'Бронь отменена до оплаты — места снова в продаже';
      const occupiedSet = this.occupiedFor(booking.sessionId);
      booking.seats.forEach((s) => occupiedSet.delete(s));
      this.notify();
      return booking;
    }
    if (booking.status !== 'CONFIRMED') {
      // как условный UPDATE … WHERE status='CONFIRMED' в API
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Отменить можно только неоплаченную или подтверждённую бронь (сейчас: ${booking.status})`,
        status: booking.status,
      }));
    }
    booking.status = 'CANCELLING';
    this.notify();

    const delay = REFUND_MIN_MS + Math.random() * (REFUND_MAX_MS - REFUND_MIN_MS);
    setTimeout(() => {
      const ok = Math.random() < REFUND_SUCCESS_RATE;
      booking.status = ok ? 'CANCELLED' : 'CONFIRMED';
      booking.message = ok
        ? `Возврат ${booking.totalRub} ₽ зачислен. Места ${booking.seats.join(', ')} снова в продаже.`
        : `Банк отклонил возврат (код ${10 + Math.floor(Math.random() * 90)}). Бронь остаётся подтверждённой, места держатся.`;
      booking.processedBy = 'go-worker (демо)';
      booking.processedAt = new Date().toISOString();
      if (ok) {
        // возврат прошёл — места снова в продаже (как booking.refunded в API)
        const occupiedSet = this.occupiedFor(booking.sessionId);
        booking.seats.forEach((s) => occupiedSet.delete(s));
      }
      this.notify();
    }, delay);

    return booking;
  }

  // ── Отзывы и рейтинги ────────────────────────────────────────────────

  /** отзывы фильма, свежие сверху (миниатюра GET /movies/:id/reviews) */
  reviewsOf(movieId: string): Review[] {
    return this.reviews
      .filter((r) => r.movieId === movieId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** право на отзыв — подтверждённая бронь (в демо — любая своя) */
  canReview(movieId: string): boolean {
    return this.bookings.some(
      (b) => b.movieId === movieId && b.status === 'CONFIRMED',
    );
  }

  /**
   * Новый отзыв гостя демо. Паритет с API: сначала валидация (400),
   * затем право по брони (403), дубль ловит «uq (user, movie)» — 409.
   * Агрегат фильма пересчитывается сразу, слушатели оповещаются.
   */
  createReview(movieId: string, payload: CreateReviewPayload): Review {
    const movie = DEMO_MOVIES.find((m) => m.id === movieId);
    if (!movie) throw new Error('Фильм не найден');

    const text = (payload.text ?? '').trim();
    if (
      !Number.isInteger(payload.rating) ||
      payload.rating < 1 ||
      payload.rating > 5
    ) {
      throw new ApiError('HTTP 400', 400, JSON.stringify({
        statusCode: 400,
        message: 'Оценка — целое число от 1 до 5',
      }));
    }
    if (text.length < 10 || text.length > 1000) {
      throw new ApiError('HTTP 400', 400, JSON.stringify({
        statusCode: 400,
        message: 'Отзыв — от 10 до 1000 символов',
      }));
    }
    if (!this.canReview(movieId)) {
      throw new ApiError('HTTP 403', 403, JSON.stringify({
        statusCode: 403,
        message:
          'Отзыв можно оставить только о фильме, на который была подтверждённая бронь',
      }));
    }
    if (
      this.reviews.some(
        (r) => r.movieId === movieId && r.userId === DEMO_GUEST_ID,
      )
    ) {
      // uq (user_id, movie_id) в миниатюре
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: 'Вы уже оставили отзыв на этот фильм',
        code: 'reviewExists',
      }));
    }

    const now = new Date().toISOString();
    const review: Review = {
      id: uuid(),
      movieId,
      userId: DEMO_GUEST_ID,
      authorName: DEMO_GUEST_NAME,
      rating: payload.rating,
      text,
      createdAt: now,
      updatedAt: now,
    };
    this.reviews.unshift(review);
    this.recomputeMovie(movieId);
    this.notify();
    return review;
  }

  /** удаление отзыва (миниатюра DELETE): пересчёт рейтинга + оповещение */
  deleteReview(movieId: string, id: string): void {
    const idx = this.reviews.findIndex(
      (r) => r.id === id && r.movieId === movieId,
    );
    if (idx === -1) throw new Error('Отзыв не найден');
    this.reviews.splice(idx, 1);
    this.recomputeMovie(movieId);
    this.notify();
  }

  /** агрегат фильма: средняя и число отзывов — от источника, как в tx API */
  private recomputeMovie(movieId: string): void {
    const movie = DEMO_MOVIES.find((m) => m.id === movieId);
    if (!movie) return;
    const mine = this.reviews.filter((r) => r.movieId === movieId);
    movie.ratingCount = mine.length;
    movie.ratingAvg = mine.length
      ? mine.reduce((acc, r) => acc + r.rating, 0) / mine.length
      : 0;
  }
}

export const demoEngine = new DemoEngine();
