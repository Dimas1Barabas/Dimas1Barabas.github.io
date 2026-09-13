import type {
  Booking,
  BookingStats,
  CreateBookingPayload,
  Movie,
  MovieSession,
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

const DEMO_MOVIES: Movie[] = [
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

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `b-${Math.random().toString(36).slice(2, 10)}`;
}

type Listener = () => void;

class DemoEngine {
  private bookings: Booking[] = [];
  private listeners = new Set<Listener>();
  private firstLoad = true;
  /** sessionId → занятые места (посев ленивый, при первом обращении) */
  private occupied = new Map<string, Set<string>>();
  /** bookingId → таймер экспирации неоплаченной брони (wait-очередь демо) */
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    this.firstLoad = true;
  }

  movies(): { source: 'cache' | 'db'; data: Movie[] } {
    const source = this.firstLoad ? 'db' : 'cache';
    this.firstLoad = false;
    return { source, data: DEMO_MOVIES };
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
}

export const demoEngine = new DemoEngine();
