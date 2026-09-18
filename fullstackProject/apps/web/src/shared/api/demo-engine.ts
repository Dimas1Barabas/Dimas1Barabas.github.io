import type {
  AdminStats,
  AdminStatsEnvelope,
  Booking,
  BookingStats,
  CreateBookingPayload,
  CreateReviewPayload,
  LoginResult,
  Movie,
  MovieSession,
  RegisterPayload,
  Review,
  SeatMap,
  UpdateProfilePayload,
  User,
} from '@/shared/api/types';
import { ApiError } from '@/shared/api/client';
import {
  HALL_CAPACITY,
  HALL_ROWS,
  HALL_SEATS_PER_ROW,
  allSeatCodes,
  compareSeats,
  isValidSeat,
} from '@/shared/lib/hall';
import {
  adminTotals,
  countByStatus,
  ratingAgg,
  revenueByDay,
  sessionOccupancy,
  topMovies,
} from '@/shared/lib/admin-stats';

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
 *    пересчитывается сразу; как reviews-модуль API;
 *  - сид-брони «других зрителей» за последние 2 недели — живое табло
 *    и данные для аналитики; их места держатся в картах сеансов;
 *  - админ-аналитика adminStats(): те же агрегаты, что GET /api/admin/stats,
 *    с «кэшем» на 30 c — миниатюра Redis-кэша боевого эндпоинта;
 *  - аккаунт: вход/регистрация/профиль/смена пароля/восстановление —
 *    симуляция auth-модуля с теми же кодами ошибок (401/403/409/400);
 *    демо-сессия живёт в памяти до перезагрузки, «письмо» сброса
 *    печатает сама страница (токен одноразовый, как в API).
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

/**
 * Сид-брони «других зрителей»: история за последние 2 недели, чтобы
 * демо-табло и админ-аналитика не пустовали (в live эти строки лежат
 * в Postgres). Статусы — терминальные: таймеров и воркеров у сидов нет.
 */
const DEMO_BOOKING_SEEDS: {
  movieId: string;
  sessionId: string;
  seats: string[];
  customerName: string;
  status: Booking['status'];
  daysAgo: number;
  /** минута вердикта относительно создания */
  verdictInMin: number;
  message?: string;
}[] = [
  { movieId: 'demo-milky-way', sessionId: 'demo-milky-way-s1', seats: ['4-3', '4-4'], customerName: 'Ольга', status: 'CONFIRMED', daysAgo: 13, verdictInMin: 5 },
  { movieId: 'demo-last-debug', sessionId: 'demo-last-debug-s1', seats: ['2-5'], customerName: 'Игорь', status: 'CONFIRMED', daysAgo: 12, verdictInMin: 5 },
  { movieId: 'demo-cache-lady', sessionId: 'demo-cache-lady-s1', seats: ['6-2', '6-3'], customerName: 'Катя', status: 'CONFIRMED', daysAgo: 11, verdictInMin: 5 },
  { movieId: 'demo-milky-way', sessionId: 'demo-milky-way-s1', seats: ['5-1', '5-2', '5-3'], customerName: 'Пётр', status: 'CONFIRMED', daysAgo: 10, verdictInMin: 5 },
  { movieId: 'demo-recursion', sessionId: 'demo-recursion-s1', seats: ['3-7'], customerName: 'Аня', status: 'FAILED', daysAgo: 9, verdictInMin: 5, message: 'Платёж отклонён банком (код 42). Бронь отменена, деньги не списаны.' },
  { movieId: 'demo-old-repo', sessionId: 'demo-old-repo-s1', seats: ['7-4', '7-5'], customerName: 'Сергей', status: 'CONFIRMED', daysAgo: 8, verdictInMin: 5 },
  { movieId: 'demo-cache-lady', sessionId: 'demo-cache-lady-s2', seats: ['1-6'], customerName: 'Настя', status: 'EXPIRED', daysAgo: 7, verdictInMin: 3, message: 'Время оплаты истекло. Бронь отменена, места снова в продаже.' },
  { movieId: 'demo-49th-stream', sessionId: 'demo-49th-stream-s1', seats: ['8-1', '8-2', '8-3', '8-4'], customerName: 'Дима', status: 'CONFIRMED', daysAgo: 6, verdictInMin: 5 },
  { movieId: 'demo-milky-way', sessionId: 'demo-milky-way-s2', seats: ['2-7', '2-8'], customerName: 'Вика', status: 'CONFIRMED', daysAgo: 5, verdictInMin: 5 },
  { movieId: 'demo-last-debug', sessionId: 'demo-last-debug-s2', seats: ['5-5', '5-6'], customerName: 'Юра', status: 'CANCELLED', daysAgo: 4, verdictInMin: 12, message: 'Возврат 640 ₽ зачислен. Места 5-5, 5-6 снова в продаже.' },
  { movieId: 'demo-old-repo', sessionId: 'demo-old-repo-s2', seats: ['3-2', '3-3', '3-4'], customerName: 'Марина', status: 'CONFIRMED', daysAgo: 3, verdictInMin: 5 },
  { movieId: 'demo-recursion', sessionId: 'demo-recursion-s2', seats: ['6-8'], customerName: 'Костя', status: 'CONFIRMED', daysAgo: 2, verdictInMin: 5 },
  { movieId: 'demo-milky-way', sessionId: 'demo-milky-way-s3', seats: ['7-7', '7-8'], customerName: 'Лена', status: 'CONFIRMED', daysAgo: 1, verdictInMin: 5 },
  { movieId: 'demo-49th-stream', sessionId: 'demo-49th-stream-s2', seats: ['4-6', '4-7'], customerName: 'Роман', status: 'CONFIRMED', daysAgo: 0, verdictInMin: 5 },
];

/** свежие объекты сид-броней: заголовки фильма — из афиши, суммы — из цены */
function seedBookings(): Booking[] {
  return DEMO_BOOKING_SEEDS.map((s, i) => {
    const movie = DEMO_MOVIES.find((m) => m.id === s.movieId)!;
    const session = movie.sessions.find((x) => x.id === s.sessionId)!;
    const createdAt = new Date(Date.now() - s.daysAgo * 86_400_000);
    // все сиды — терминальные статусы: вердикт «уже случился»
    const processedAt = new Date(createdAt.getTime() + s.verdictInMin * 60_000);
    const verdictMessage =
      s.message ??
      (s.status === 'CONFIRMED'
        ? `Оплата ${movie.priceRub * s.seats.length} ₽ прошла. Места ${s.seats.join(', ')}. Приятного просмотра!`
        : null);
    return {
      id: `demo-seed-b${i + 1}`,
      movieId: movie.id,
      movieTitle: movie.title,
      movieHue: movie.hue,
      movieGenreIcon: movie.genreIcon,
      sessionId: session.id,
      sessionAt: session.startsAt,
      hall: session.hall,
      customerName: s.customerName,
      // сиды — «другие зрители»: гость демо не может их отменить/отозвать
      userId: `demo-seed-${i + 1}`,
      seats: [...s.seats],
      totalRub: movie.priceRub * s.seats.length,
      status: s.status,
      expiresAt: null,
      message: verdictMessage,
      processedBy: 'go-worker (демо)',
      processedAt: processedAt ? processedAt.toISOString() : null,
      createdAt: createdAt.toISOString(),
    } satisfies Booking;
  });
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
  /** «Redis-кэш» аналитики: значение + время расчёта (TTL как у API) */
  private statsCache: AdminStats | null = null;
  private statsAt = 0;
  /** демо-аккаунт (регистрация/вход) и открытая сессия — только в памяти */
  private account: { email: string; name: string; password: string } | null = null;
  private session: User | null = null;

  /** «access-токен» демо-сессии — не JWT, просто маркер для стора */
  static readonly SESSION_TOKEN = 'demo-session';
  /** одноразовый токен «письма» сброса: страница показывает ссылку сама */
  static readonly RESET_TOKEN = 'demo-reset-token';
  /** «занятый» email — витрина может показать честный 409 emailTaken */
  static readonly TAKEN_EMAIL = 'admin@cine.local';

  constructor() {
    // стартовые агрегаты рейтинга — из сид-отзывов (как recompute в tx API)
    DEMO_MOVIES.forEach((m) => this.recomputeMovie(m.id));
    this.applySeeds();
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
    this.occupied.clear();
    this.reviews = seedReviews();
    this.account = null;
    this.session = null;
    DEMO_MOVIES.forEach((m) => this.recomputeMovie(m.id));
    this.firstLoad = true;
    this.applySeeds();
  }

  // ── Аккаунт: симуляция auth-модуля API ────────────────────────────
  // Сессия живёт в памяти движка: перезагрузка страницы — как протухшая
  // сессия, выход. localStorage демо не трогает. Ошибки — те же ApiError
  // с теми же кодами и текстами, что у живого API.

  /** вход: любой email до первой регистрации; после — сверка пароля (401) */
  login(email: string, password: string): LoginResult {
    const normalized = email.trim().toLowerCase();
    if (
      this.account &&
      (this.account.email !== normalized || this.account.password !== password)
    ) {
      throw new ApiError(
        'HTTP 401',
        401,
        JSON.stringify({ message: 'Неверный email или пароль' }),
      );
    }
    if (!this.account) {
      this.account = { email: normalized, name: 'Гость', password };
    }
    return this.openSession();
  }

  /** регистрация: занятый email (свой или демо-админ) — 409 emailTaken */
  register(payload: RegisterPayload): User {
    const email = payload.email.trim().toLowerCase();
    if (this.account?.email === email || email === DemoEngine.TAKEN_EMAIL) {
      throw new ApiError(
        'HTTP 409',
        409,
        JSON.stringify({
          message: 'Этот email уже зарегистрирован',
          code: 'emailTaken',
        }),
      );
    }
    this.account = {
      email,
      name: payload.name.trim(),
      password: payload.password,
    };
    return this.userOf();
  }

  logout(): void {
    this.session = null;
  }

  /** профиль: имя/email; ответ — «свежая пара», как PATCH /users/me */
  updateProfile(payload: UpdateProfilePayload): LoginResult {
    this.requireSession();
    const email = payload.email?.trim().toLowerCase();
    if (
      email &&
      email !== this.account?.email &&
      email === DemoEngine.TAKEN_EMAIL
    ) {
      throw new ApiError(
        'HTTP 409',
        409,
        JSON.stringify({
          message: 'Этот email уже зарегистрирован',
          code: 'emailTaken',
        }),
      );
    }
    if (email) this.account!.email = email;
    if (payload.name?.trim()) this.account!.name = payload.name.trim();
    this.session = this.userOf();
    return this.openSession();
  }

  /** смена пароля: неверный текущий — 403, как PUT /users/me/password */
  changePassword(currentPassword: string, newPassword: string): LoginResult {
    this.requireSession();
    if (currentPassword !== this.account!.password) {
      throw new ApiError(
        'HTTP 403',
        403,
        JSON.stringify({ message: 'Неверный текущий пароль' }),
      );
    }
    this.account!.password = newPassword;
    return this.openSession();
  }

  /** «письмо» сброса: движок отдаёт токен, страницу-письмо рисует фронт */
  forgotPassword(_email: string): string {
    return DemoEngine.RESET_TOKEN;
  }

  /** сброс по ссылке: одноразовый токен, мёртвый — 400 тем же текстом */
  resetPassword(token: string, newPassword: string): LoginResult {
    if (!this.account || token !== DemoEngine.RESET_TOKEN) {
      throw new ApiError(
        'HTTP 400',
        400,
        JSON.stringify({ message: 'Ссылка недействительна или истекла' }),
      );
    }
    this.account.password = newPassword;
    return this.openSession();
  }

  private requireSession(): void {
    if (!this.session || !this.account) {
      throw new ApiError(
        'HTTP 401',
        401,
        JSON.stringify({ message: 'Не авторизован' }),
      );
    }
  }

  private openSession(): LoginResult {
    this.session = this.userOf();
    return { accessToken: DemoEngine.SESSION_TOKEN, user: { ...this.session } };
  }

  private userOf(): User {
    const account = this.account!;
    return {
      id: DEMO_GUEST_ID,
      email: account.email,
      name: account.name,
      role: 'user',
      createdAt: new Date().toISOString(),
    };
  }

  /** сид-брони «других зрителей» + их места в картах сеансов */
  private applySeeds(): void {
    this.bookings = seedBookings();
    this.statsCache = null;
    this.statsAt = 0;
    // CONFIRMED-сиды держат места (как seat_occupancy в Postgres);
    // терминальные FAILED/EXPIRED/CANCELLED — освободили
    for (const b of this.bookings) {
      if (b.status === 'CONFIRMED') {
        b.seats.forEach((s) => this.occupiedFor(b.sessionId).add(s));
      }
    }
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

  // ── Админ-аналитика ─────────────────────────────────────────────────

  /** TTL «кэша» аналитики — как ADMIN_STATS_KEY в API (30 c) */
  private static STATS_TTL_MS = 30_000;

  /**
   * Миниатюра GET /api/admin/stats: агрегаты дашборда из состояния движка,
   * конверт {source, data} с «кэшем» 30 c — как Redis в боевом эндпоинте
   * (пересчёт и в live, и в демо виден не мгновенно, а по TTL).
   */
  adminStats(): AdminStatsEnvelope {
    const fresh =
      this.statsCache !== null && Date.now() - this.statsAt < DemoEngine.STATS_TTL_MS;
    if (this.statsCache && fresh) {
      return { source: 'cache', data: plainCopy(this.statsCache) };
    }
    const data = this.computeAdminStats();
    this.statsCache = data;
    this.statsAt = Date.now();
    return { source: 'db', data: plainCopy(data) };
  }

  private computeAdminStats(): AdminStats {
    const now = Date.now();
    // предстоящие сеансы всех фильмов по возрастанию времени
    const upcoming = DEMO_MOVIES.flatMap((m) =>
      m.sessions
        .filter((s) => Date.parse(s.startsAt) >= now)
        .map((s) => ({
          id: s.id,
          movieTitle: m.title,
          hall: s.hall,
          startsAt: new Date(s.startsAt),
        })),
    ).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

    // занятость — та же карта, что видит покупатель в seatMap
    const occupiedBySession = new Map(
      upcoming.map((s) => [s.id, this.occupiedFor(s.id).size]),
    );
    const titles = new Map(DEMO_MOVIES.map((m) => [m.id, m.title]));
    const ratings = ratingAgg(this.reviews);
    const occ = sessionOccupancy(upcoming, occupiedBySession);

    return {
      totals: adminTotals(this.bookings, {
        moviesCount: DEMO_MOVIES.length,
        reviewsCount: ratings.count,
        avgRating: ratings.avg,
        upcomingAvgPct: occ.avgPct,
      }),
      byStatus: countByStatus(this.bookings),
      topMovies: topMovies(this.bookings, titles),
      upcomingSessions: occ.list,
      revenueByDay: revenueByDay(this.bookings),
    };
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

  /** право на отзыв — своя CONFIRMED-бронь: гость демо без владельца
   *  (userId null); сиды «других зрителей» права не дают — как в API */
  canReview(movieId: string): boolean {
    return this.bookings.some(
      (b) => b.movieId === movieId && b.status === 'CONFIRMED' && !b.userId,
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

/** глубокая копия JSON-данных: движок живёт вне реактивности Vue —
 *  каждой выдаче нужны свежие идентичности (как JSON по проводам в live) */
function plainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
