import type {
  Booking,
  BookingStats,
  CreateBookingPayload,
  Movie,
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
 *  - фильмы с пометкой источника «кэш»/«БД» (как Redis-кэш API);
 *  - карта занятости зала, детерминированно посеянная при первом заходе
 *    (в живом стенде места занимают брони в Postgres);
 *  - созданная бронь держит выбранные места; конфликт мест — 409, как
 *    уникальный констрейнт (movie_id, seat) в API;
 *  - через 1,2–2,8 с «воркер» (те же тайминги и вероятность успеха, что у
 *    Go ticket-worker) выносит вердикт; при FAILED места освобождаются;
 *  - сага отмены: CONFIRMED → CANCELLING → возврат 0,8–1,6 с с той же
 *    вероятностью успеха, что у воркера; места освобождаются при успехе.
 */

const SUCCESS_RATE = 0.9;
const MIN_MS = 1200;
const MAX_MS = 2800;
/** сага отмены — те же тайминги/вероятность, что у возврата в Go-воркере */
const REFUND_SUCCESS_RATE = 0.9;
const REFUND_MIN_MS = 800;
const REFUND_MAX_MS = 1600;

function inDays(days: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
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
    sessionAt: inDays(1, 19),
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
    sessionAt: inDays(1, 21),
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
    sessionAt: inDays(2, 18),
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
    sessionAt: inDays(2, 22),
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
    sessionAt: inDays(3, 15),
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
    sessionAt: inDays(3, 20),
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
  /** movieId → занятые места (посев ленивый, при первом обращении) */
  private occupied = new Map<string, Set<string>>();

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }

  /** сброс состояния (тесты) */
  reset(): void {
    this.bookings = [];
    this.occupied.clear();
    this.firstLoad = true;
  }

  movies(): { source: 'cache' | 'db'; data: Movie[] } {
    const source = this.firstLoad ? 'db' : 'cache';
    this.firstLoad = false;
    return { source, data: DEMO_MOVIES };
  }

  /**
   * Детерминированный «посев» занятости: без случайностей, чтобы демо
   * выглядел живым, а тесты — стабильными (~20% зала занято).
   */
  private occupiedFor(movieId: string): Set<string> {
    let seats = this.occupied.get(movieId);
    if (!seats) {
      seats = new Set<string>();
      let h = 0;
      for (const ch of movieId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      for (const code of allSeatCodes()) {
        const [row, num] = code.split('-').map(Number);
        if ((h + row * 7 + num * 3) % 5 === 0) seats.add(code);
      }
      this.occupied.set(movieId, seats);
    }
    return seats;
  }

  seatMap(movieId: string): SeatMap {
    if (!DEMO_MOVIES.some((m) => m.id === movieId)) {
      throw new Error('Фильм не найден');
    }
    const occupied = [...this.occupiedFor(movieId)].sort(compareSeats);
    return {
      movieId,
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
      PENDING: 0,
      CONFIRMED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    };
    for (const b of this.bookings) stats[b.status] += 1;
    return stats;
  }

  create(payload: CreateBookingPayload): Booking {
    const movie = DEMO_MOVIES.find((m) => m.id === payload.movieId);
    if (!movie) throw new Error('Фильм не найден');

    const seats = [...new Set(payload.seats)].sort(compareSeats);
    const invalid = seats.filter((s) => !isValidSeat(s));
    if (invalid.length > 0) {
      throw new ApiError('HTTP 400', 400, JSON.stringify({
        statusCode: 400,
        message: `Некорректные места: ${invalid.join(', ')}`,
      }));
    }

    // уникальный констрейнт (movie_id, seat) в миниатюре
    const occupied = this.occupiedFor(movie.id);
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
      customerName: (payload.customerName ?? 'Гость').trim(),
      seats,
      totalRub: movie.priceRub * seats.length,
      status: 'PENDING',
      message: null,
      processedBy: null,
      processedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.bookings.unshift(booking);
    this.notify();

    // «Go-воркер»: та же задержка и вероятность успеха, что в services/ticket-worker
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
        const occupiedSet = this.occupiedFor(movie.id);
        booking.seats.forEach((s) => occupiedSet.delete(s));
      }
      this.notify();
    }, delay);

    return booking;
  }

  /**
   * Сага отмены: CONFIRMED → CANCELLING, затем «возврат платежа» —
   * те же тайминги и вероятность отказа, что у Go-воркера.
   * Успех освобождает места, отказ откатывает бронь в CONFIRMED.
   */
  cancel(id: string): Booking {
    const booking = this.bookings.find((b) => b.id === id);
    if (!booking) throw new Error('Бронь не найдена');
    if (booking.status !== 'CONFIRMED') {
      // как условный UPDATE … WHERE status='CONFIRMED' в API
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Отменить можно только подтверждённую бронь (сейчас: ${booking.status})`,
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
        const occupiedSet = this.occupiedFor(booking.movieId);
        booking.seats.forEach((s) => occupiedSet.delete(s));
      }
      this.notify();
    }, delay);

    return booking;
  }
}

export const demoEngine = new DemoEngine();
