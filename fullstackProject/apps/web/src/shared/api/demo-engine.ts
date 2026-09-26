import type {
  AdminStats,
  AdminStatsEnvelope,
  Booking,
  BookingStats,
  BonusAccount,
  BonusKind,
  BonusReason,
  BonusTransaction,
  CreateBookingPayload,
  CreatePromoPayload,
  CreateReviewPayload,
  LoginResult,
  Movie,
  MovieSession,
  Promo,
  PromoPreview,
  RecommendationsDto,
  RegisterPayload,
  ReminderStreamEvent,
  Review,
  SeatMap,
  SessionQuote,
  Ticket,
  TicketVerifyResult,
  UpdateProfilePayload,
  User,
  ValidatePromoPayload,
  MyWaitlistEntry,
  WaitlistEntry,
  WaitlistStatus,
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
import { BONUS_SPEND_LIMIT, cashbackFor } from '@/shared/lib/bonus';
import { quoteSession } from '@/shared/lib/pricing';
import {
  rankRecommendations,
  type RecSignal,
} from '@/shared/lib/recommendation';
import {
  PROMO_CODE_RE,
  normalizePromoCode,
  promoDiscount,
} from '@/shared/lib/promo';
import {
  parseTicketQr,
  signTicket,
  ticketCanonical,
  ticketNoOf,
  ticketSignatureMatches,
} from '@/shared/lib/ticket';
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
/** кэшбэк демо — как дефолт BONUS_CASHBACK_PERCENT у API */
const DEMO_CASHBACK_PERCENT = 5;
/** окно напоминания демо — паритет с REMINDER_LEAD_MINUTES стенда (2 мин) */
const DEMO_REMINDER_LEAD_MS = 120_000;
/** …но задержку зажимаем в 3–60 с: сид-сеансы через часы и дни,
 *  а письмо должно прийти за один визит в демо */
const REMINDER_DELAY_MIN_MS = 3_000;
const REMINDER_DELAY_MAX_MS = 60_000;

/** сид бонусного счёта: история прошлых броней «гостя демо», баланс 350 */
function seedBonusLedger(): BonusTransaction[] {
  const daysAgo = (d: number) =>
    new Date(Date.now() - d * 86_400_000).toISOString();
  return [
    {
      id: 'demo-bonus-1',
      kind: 'accrual',
      reason: 'cashback',
      amount: 140,
      bookingId: 'demo-booking-seed-1',
      createdAt: daysAgo(10),
    },
    {
      id: 'demo-bonus-2',
      kind: 'spend',
      reason: 'payment',
      amount: 90,
      bookingId: 'demo-booking-seed-2',
      createdAt: daysAgo(6),
    },
    {
      id: 'demo-bonus-3',
      kind: 'accrual',
      reason: 'cashback',
      amount: 300,
      bookingId: 'demo-booking-seed-3',
      createdAt: daysAgo(2),
    },
  ];
}

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
/**
 * Сид-сигналы КиноСоветника: демо-зритель «раньше» ходил на фантастику
 * и высоко её оценил — блок «Вам понравится» сразу показывает profile-ветку.
 */
function seedSignals(): RecSignal[] {
  return [
    {
      movieId: 'demo-milky-way',
      genre: 'фантастика',
      kind: 'booking',
      rating: 0,
      dedupKey: 'seed:booking:demo-milky-way',
    },
    {
      movieId: 'demo-milky-way',
      genre: 'фантастика',
      kind: 'review',
      rating: 5,
      dedupKey: 'seed:review:demo-milky-way',
    },
  ];
}

const DEMO_MOVIES: Movie[] = DEMO_MOVIE_SEEDS.map((m) => ({
  ...m,
  ratingAvg: 0,
  ratingCount: 0,
}));

/** «текущий пользователь» демо: авторизации нет, все его отзывы — гостевые */
const DEMO_GUEST_ID = 'demo-guest';
const DEMO_GUEST_NAME = 'Гость';
/** паритет с политиками Привратника (RATE_*_PER_MIN Go-сервиса) */
const DEMO_RATE_BOOKINGS_PER_MIN = 10;
const DEMO_RATE_LOGIN_PER_MIN = 5;

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
  // «аншлаг»: корпоратив выкупил зал целиком — сеанс демо-Рекурсия-s1
  // полный, на нём витрина листа ожидания (seats = все 80 мест)
  { movieId: 'demo-recursion', sessionId: 'demo-recursion-s1', seats: allSeatCodes(), customerName: 'КиноКлуб «Аншлаг»', status: 'CONFIRMED', daysAgo: 0, verdictInMin: 5 },
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
      promoCode: null,
      discountRub: null,
      bonusSpent: null,
      status: s.status,
      expiresAt: null,
      message: verdictMessage,
      processedBy: 'go-worker (демо)',
      processedAt: processedAt ? processedAt.toISOString() : null,
      createdAt: createdAt.toISOString(),
    } satisfies Booking;
  });
}

/**
 * Сид-промокоды демо: CINE10 — витринный процент; SUMMER300 — фикс
 * «почти исчерпан» (2 из 3), честный 409 на витрине; EXPIRED5 —
 * истёкший вчера, показывает 410. Как строки promos в Postgres.
 */
function seedPromos(): Promo[] {
  return [
    {
      id: 'demo-promo-cine10',
      code: 'CINE10',
      kind: 'percent',
      value: 10,
      maxActivations: 100,
      usedCount: 0,
      expiresAt: inDays(30, 12),
      createdAt: '2026-09-19T00:00:00.000Z',
    },
    {
      id: 'demo-promo-summer300',
      code: 'SUMMER300',
      kind: 'fixed',
      value: 300,
      maxActivations: 3,
      usedCount: 2,
      expiresAt: inDays(30, 12),
      createdAt: '2026-09-18T00:00:00.000Z',
    },
    {
      id: 'demo-promo-expired5',
      code: 'EXPIRED5',
      kind: 'percent',
      value: 5,
      maxActivations: 10,
      usedCount: 0,
      expiresAt: inDays(-1, 12),
      createdAt: '2026-08-01T00:00:00.000Z',
    },
  ];
}

type Listener = () => void;

/** запись листа ожидания в состоянии движка (как waitlist_entries в Postgres) */
interface DemoWaitlistEntry {
  id: string;
  sessionId: string;
  userId: string;
  status: WaitlistStatus;
  queuedAt: string;
  notifiedAt: string | null;
  createdAt: string;
}

class DemoEngine {
  private bookings: Booking[] = [];
  /** отзывы всех фильмов; «гость демо» — как user из JWT в live-режиме */
  private reviews: Review[] = seedReviews();
  private listeners = new Set<Listener>();
  private firstLoad = true;
  /** sessionId → занятые места (посев ленивый, при первом обращении) */
  private occupied = new Map<string, Set<string>>();
  /** sessionId → места, занятые симулянтом «других зрителей» живой карты
   *  (освобождать можно только их — сиды и брони пользователя неприкосновенны) */
  private viewerSeats = new Map<string, Set<string>>();
  /** bookingId → таймер экспирации неоплаченной брони (wait-очередь демо) */
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** «Redis-кэш» аналитики: значение + время расчёта (TTL как у API) */
  private statsCache: AdminStats | null = null;
  private statsAt = 0;
  /** демо-аккаунт (регистрация/вход) и открытая сессия — только в памяти */
  private account: { email: string; name: string; password: string } | null = null;
  private session: User | null = null;
  /** промокоды демо: сиды + созданные в админке демо */
  private promos: Promo[] = seedPromos();
  /** лист ожидания: записи по сеансам (порядок очереди — по queuedAt) */
  private waitlist: DemoWaitlistEntry[] = [];
  /** бонусный счёт демо: ledger движений (баланс — SUM от источника) */
  private bonusLedger: BonusTransaction[] = seedBonusLedger();
  /** счётчик id строк ledger'а — детерминированные «demo-bonus-N» */
  private bonusSeq = seedBonusLedger().length;
  /** сигналы КиноСоветника: бронь CONFIRMED = «смотрел», отзыв = «оценил» */
  private signals: RecSignal[] = seedSignals();
  /** token-корзины лимитов «Привратника» — то же зеркало, что в Go-домене */
  private rateBuckets = new Map<string, { tokens: number; updatedAt: number }>();
  /** напоминания «скоро сеанс»: отправленные письма, свежими сверху */
  private remindersSent: ReminderStreamEvent[] = [];
  /** bookingId → таймер напоминания (как SCHEDULED-записи Go-сервиса) */
  private reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /**
   * token bucket в миниатюре — та же арифметика, что в domain.Check
   * Go-сервиса Привратника: первому визиту — полный бак, равномерный
   * долив perMin/60 в секунду, отказ токен не списывает. Отказ —
   * ApiError 429 с retryAfterSec, зеркально RateLimitGuard API.
   */
  private takeToken(action: string, key: string, perMin: number): void {
    const now = Date.now();
    const id = `${action}:${key}`;
    const b = this.rateBuckets.get(id) ?? { tokens: perMin, updatedAt: now };
    b.tokens = Math.min(perMin, b.tokens + ((now - b.updatedAt) / 1000) * (perMin / 60));
    b.updatedAt = now;
    this.rateBuckets.set(id, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    const retryAfterSec = Math.max(1, Math.ceil((1 - b.tokens) / (perMin / 60)));
    throw new ApiError(
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
  }

  /** сброс состояния (тесты) */
  reset(): void {
    this.expiryTimers.forEach((t) => clearTimeout(t));
    this.expiryTimers.clear();
    this.reminderTimers.forEach((t) => clearTimeout(t));
    this.reminderTimers.clear();
    this.remindersSent = [];
    this.occupied.clear();
    this.viewerSeats.clear();
    this.rateBuckets.clear();
    this.reviews = seedReviews();
    this.account = null;
    this.session = null;
    this.promos = seedPromos();
    this.waitlist = [];
    this.bonusLedger = seedBonusLedger();
    this.bonusSeq = seedBonusLedger().length;
    this.signals = seedSignals();
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
    // лимит до проверки пароля — как гвард API: неверные попытки тоже
    // едят корзину, брутфорс исчерпывает её раньше подбора
    this.takeToken('auth.login', normalized, DEMO_RATE_LOGIN_PER_MIN);
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

  /**
   * Цена места сеанса — зеркало GET /api/sessions/:id/price: правила
   * Тарификатора (shared/lib/pricing — векторы сверены с Go-тестами),
   * занятость — та же карта, что видит покупатель. В демо Тарификатор
   * «всегда доступен»: dynamic=true.
   */
  quote(sessionId: string): SessionQuote {
    const found = this.findSession(sessionId);
    if (!found) throw new Error('Сеанс не найден');
    const q = quoteSession({
      sessionId,
      startsAt: found.session.startsAt,
      basePriceRub: found.movie.priceRub,
      occupied: this.occupiedFor(sessionId).size,
      capacity: HALL_CAPACITY,
    });
    return { ...q, sessionAt: found.session.startsAt, dynamic: true };
  }

  /**
   * Живая карта в демо: «другой зритель» занимает или освобождает место,
   * пока открыта модалка выбора. Занимает только свободное — не сиды
   * и не выбор локального пользователя (avoid); освобождает — только
   * места симулянта (viewerSeats). Ветвь освобождения зовёт releaseWaitlist —
   * паритет с четырьмя точками освобождения живого API.
   */
  simulateOtherViewer(
    sessionId: string,
    avoid: string[],
  ): 'taken' | 'released' | 'none' {
    if (!this.findSession(sessionId)) return 'none';
    const releaseBranch = Math.random() < 0.3;
    if (releaseBranch) {
      const mine = this.viewerSeats.get(sessionId);
      if (!mine || mine.size === 0) return 'none';
      const seat = [...mine][Math.floor(Math.random() * mine.size)];
      mine.delete(seat);
      if (mine.size === 0) this.viewerSeats.delete(sessionId);
      this.occupiedFor(sessionId).delete(seat);
      this.releaseWaitlist(sessionId);
      this.notify();
      return 'released';
    }
    const taken = this.occupiedFor(sessionId);
    const avoidSet = new Set(avoid);
    const free = allSeatCodes().filter(
      (code) => !taken.has(code) && !avoidSet.has(code),
    );
    if (free.length === 0) return 'none'; // аншлаг — симулянту нечего занимать
    const seat = free[Math.floor(Math.random() * free.length)];
    taken.add(seat);
    const mine = this.viewerSeats.get(sessionId) ?? new Set<string>();
    mine.add(seat);
    this.viewerSeats.set(sessionId, mine);
    this.notify();
    return 'taken';
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

  // ── Промокоды: симуляция promos-модуля API ────────────────────────
  // Коды ошибок и тексты — те же, что у живого API: превью не списывает
  // активацию, списание — в pay, гонку за последний код решает счётчик.

  /** список для админки: свежие сверху, копии (движок не реактивен) */
  listPromos(): Promo[] {
    return [...this.promos]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((p) => ({ ...p }));
  }

  createPromo(payload: CreatePromoPayload): Promo {
    if (!PROMO_CODE_RE.test(payload.code.trim())) {
      throw new ApiError('HTTP 400', 400, JSON.stringify({
        message: 'Код: 3–32 символа — латиница, цифры и дефис',
      }));
    }
    if (payload.kind === 'percent' && payload.value > 99) {
      throw new ApiError('HTTP 400', 400, JSON.stringify({
        message: 'Процент скидки — не больше 99',
      }));
    }
    const expiresAt = new Date(payload.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw new ApiError('HTTP 400', 400, JSON.stringify({
        message: 'Срок действия промокода должен быть в будущем',
      }));
    }
    const code = normalizePromoCode(payload.code);
    if (this.promos.some((p) => p.code === code)) {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Промокод ${code} уже существует`,
        code: 'promoExists',
      }));
    }
    const promo: Promo = {
      id: uuid(),
      code,
      kind: payload.kind,
      value: payload.value,
      maxActivations: payload.maxActivations,
      usedCount: 0,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.promos.push(promo);
    return { ...promo };
  }

  /** превью на брони без списания — как POST /promos/validate */
  validatePromo(payload: ValidatePromoPayload): PromoPreview {
    const booking = this.bookings.find((b) => b.id === payload.bookingId);
    if (!booking) {
      throw new ApiError('HTTP 404', 404, JSON.stringify({
        statusCode: 404,
        error: 'Not Found',
        message: 'Бронь не найдена',
      }));
    }
    if (booking.status !== 'PENDING_PAYMENT') {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Промокод применяется только к бронь, ждущей оплаты (сейчас: ${booking.status})`,
        status: booking.status,
      }));
    }
    const promo = this.activePromo(payload.code);
    const discountRub = promoDiscount(booking.totalRub, promo.kind, promo.value);
    return {
      code: promo.code,
      kind: promo.kind,
      value: promo.value,
      discountRub,
      totalRub: booking.totalRub - discountRub,
    };
  }

  /** активный промокод по коду либо ApiError-причина (404/410/409) */
  private activePromo(raw: string): Promo {
    const code = normalizePromoCode(raw);
    const promo = this.promos.find((p) => p.code === code);
    if (!promo) {
      throw new ApiError('HTTP 404', 404, JSON.stringify({
        statusCode: 404,
        error: 'Not Found',
        message: 'Промокод не найден',
        code: 'promoNotFound',
      }));
    }
    if (Date.parse(promo.expiresAt) <= Date.now()) {
      throw new ApiError('HTTP 410', 410, JSON.stringify({
        statusCode: 410,
        error: 'Gone',
        message: `Срок действия промокода ${promo.code} истёк`,
        code: 'promoExpired',
      }));
    }
    if (promo.usedCount >= promo.maxActivations) {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Лимит активаций промокода ${promo.code} исчерпан`,
        code: 'promoExhausted',
      }));
    }
    return promo;
  }

  create(payload: CreateBookingPayload): Booking {
    // лимит первым делом — как гвард API до валидации тела: 429 бьёт 400/409
    this.takeToken(
      'bookings.create',
      this.session?.id ?? DEMO_GUEST_ID,
      DEMO_RATE_BOOKINGS_PER_MIN,
    );
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
    // цена места — квот «Тарификатора» до занятия мест: чек фиксирует
    // цену момента брони (как create() в API — квот до транзакции)
    const quote = this.quote(session.id);

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
      totalRub: quote.priceRub * seats.length,
      promoCode: null,
      discountRub: null,
      bonusSpent: null,
      status: 'PENDING_PAYMENT',
      expiresAt: new Date(Date.now() + DEMO_PAYMENT_TIMEOUT_MS).toISOString(),
      message: null,
      processedBy: null,
      processedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.bookings.unshift(booking);
    // бронь создана — запись в листе ожидания этого сеанса больше не нужна
    for (const w of this.waitlist) {
      if (w.sessionId === session.id && w.userId === DEMO_GUEST_ID) {
        w.status = 'LEFT';
      }
    }
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
        this.releaseWaitlist(booking.sessionId);
        this.notify();
      }, DEMO_PAYMENT_TIMEOUT_MS),
    );

    return booking;
  }

  /**
   * Оплата: PENDING_PAYMENT → PENDING (условный переход — 409 иначе),
   * затем «воркер» проводит платёж. Миниатюра POST /bookings/:id/pay.
   * Промокод и бонусы — как в транзакции API: сначала валидация
   * (промо жив, бонусы в лимите и на счету), потом «коммит» — отказ
   * ничего не мутирует (бронь остаётся payable, активация не списана).
   * Бонусы списываются после скидки: лимит «половина чека» — от остатка.
   */
  pay(id: string, promoCode?: string, useBonuses?: number): Booking {
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
    // валидация промокода — без мутаций (activePromo бросает 404/410/409)
    const promo = promoCode ? this.activePromo(promoCode) : null;
    const discountRub = promo
      ? promoDiscount(booking.totalRub, promo.kind, promo.value)
      : 0;
    const base = booking.totalRub - discountRub;

    // валидация бонусов: лимит половины чека (после промо) и баланс
    if (useBonuses && useBonuses > Math.floor(base * BONUS_SPEND_LIMIT)) {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: 'Бонусами можно закрыть не больше половины чека',
        code: 'bonusOverLimit',
      }));
    }
    if (useBonuses && useBonuses > this.bonusBalance()) {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Не хватает бонусов: на счету ${this.bonusBalance()}`,
        code: 'bonusInsufficient',
      }));
    }

    // «коммит транзакции»: активация, статус, списание, финальная сумма
    if (promo) promo.usedCount += 1; // атомарный инкремент в миниатюре
    const timer = this.expiryTimers.get(booking.id);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(booking.id);
    }
    booking.status = 'PENDING';
    if (promo) {
      booking.promoCode = promo.code;
      booking.discountRub = discountRub;
    }
    if (useBonuses) {
      booking.bonusSpent = useBonuses;
      this.pushBonus({
        kind: 'spend',
        reason: 'payment',
        amount: useBonuses,
        bookingId: booking.id,
      });
    }
    booking.totalRub = base - (useBonuses ?? 0);
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
      if (ok) {
        // кэшбэк: процент от финальной суммы — как handleProcessed в API
        const cashback = cashbackFor(booking.totalRub, DEMO_CASHBACK_PERCENT);
        if (cashback > 0) {
          this.pushBonus({
            kind: 'accrual',
            reason: 'cashback',
            amount: cashback,
            bookingId: booking.id,
          });
        }
        // КиноСоветник: «сходил на фильм» — сигнал профиля рекомендаций
        const movie = DEMO_MOVIES.find((m) => m.id === booking.movieId);
        if (movie) {
          this.pushSignal({
            movieId: booking.movieId,
            genre: movie.genre,
            kind: 'booking',
            rating: 0,
            dedupKey: `booking:${booking.id}`,
          });
        }
        // напоминание «скоро сеанс» — как ScheduleReminder gRPC в API:
        // письмо взводится вердиктом CONFIRMED, гасится возвратом
        this.armReminder(booking);
      } else {
        // оплата не прошла — места возвращаются в продажу (как в API),
        // списанные бонусы возвращаются на счёт
        const occupiedSet = this.occupiedFor(booking.sessionId);
        booking.seats.forEach((s) => occupiedSet.delete(s));
        this.releaseWaitlist(booking.sessionId);
        if (booking.bonusSpent) {
          this.pushBonus({
            kind: 'accrual',
            reason: 'payment_failed',
            amount: booking.bonusSpent,
            bookingId: booking.id,
          });
        }
      }
      this.notify();
    }, delay);
  }

  /**
   * Напоминание «скоро сеанс» — зеркало ScheduleReminder gRPC: таймер
   * на «сеанс − окно»; упущенное окно — не раньше минимума, дальний
   * сеанс — не позже максимума (сид-сеансы через часы и дни, а письмо
   * должно прийти за один визит в демо). Сработавший таймер проверяет
   * статус: возврат к этому моменту письмо уже погасил.
   */
  private armReminder(booking: Booking): void {
    const sessionAt = Date.parse(booking.sessionAt);
    if (!Number.isFinite(sessionAt) || sessionAt <= Date.now()) return; // сеанс прошёл
    const delay = Math.min(
      Math.max(sessionAt - DEMO_REMINDER_LEAD_MS - Date.now(), REMINDER_DELAY_MIN_MS),
      REMINDER_DELAY_MAX_MS,
    );
    const timer = setTimeout(() => {
      this.reminderTimers.delete(booking.id);
      if (booking.status !== 'CONFIRMED') return; // письмо погашено возвратом
      this.remindersSent.unshift({
        userId: booking.userId ?? DEMO_GUEST_ID,
        bookingId: booking.id,
        movieId: booking.movieId,
        movieTitle: booking.movieTitle,
        hall: booking.hall,
        sessionAt: booking.sessionAt,
        seats: [...booking.seats],
        remindedAt: new Date().toISOString(),
      });
      this.notify();
    }, delay);
    this.reminderTimers.set(booking.id, timer);
  }

  /** отправленные напоминания — копии, свежими сверху (стор витрины) */
  reminders(): ReminderStreamEvent[] {
    return this.remindersSent.map((r) => ({ ...r, seats: [...r.seats] }));
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
      this.releaseWaitlist(booking.sessionId);
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
        // возврат прошёл — места снова в продаже (как booking.refunded
        // в API), бонусы разворачиваются: списанное вернулось, кэшбэк
        // погасился (но не в минус)
        const occupiedSet = this.occupiedFor(booking.sessionId);
        booking.seats.forEach((s) => occupiedSet.delete(s));
        this.releaseWaitlist(booking.sessionId);
        this.reverseBookingBonuses(booking);
        // билеты вернулись — напоминание гасим (как Cancel gRPC в API);
        // REFUND_FAILED-откат ниже по коду сюда не попадает — письмо ждёт
        const reminder = this.reminderTimers.get(booking.id);
        if (reminder) {
          clearTimeout(reminder);
          this.reminderTimers.delete(booking.id);
        }
      }
      this.notify();
    }, delay);

    return booking;
  }

  // ── Бонусы: ledger движений в миниатюре ─────────────────────────────
  // Как bonus_transactions в Postgres: записи только добавляются, баланс
  // считается SUM'ом от источника; uq(booking_id, reason) — дубль
  // операции одного типа по бронь не вставляется (идемпотентность).

  /** счёт «гостя демо»: баланс + история свежими сверху */
  // ── КиноСоветник: рекомендации ─────────────────────────────────────
  // Тот же алгоритм, что в Go-сервисе: зеркало shared/lib/recommendation.
  // Сигналы копит движок (бронь CONFIRMED, отзыв), сиды дают истории
  // «прошлых просмотров», чтобы блок жил сразу после входа в демо.

  /** топ «Вам понравится» для демо-зрителя среди текущей афиши */
  recommendations(): RecommendationsDto {
    const candidates = this.movies().data.map((m) => ({
      movieId: m.id,
      title: m.title,
      genre: m.genre,
      ratingAvg: m.ratingAvg ?? 0,
      ratingCount: m.ratingCount ?? 0,
    }));
    const ranked = rankRecommendations(candidates, this.signals);
    return { items: ranked.items, basis: ranked.basis };
  }

  /** сигнал профиля: дубль по dedup-ключу не проходит (как uq в Postgres) */
  private pushSignal(signal: RecSignal): void {
    if (this.signals.some((s) => s.dedupKey === signal.dedupKey)) return;
    this.signals.push(signal);
  }

  myBonuses(limit = 20): BonusAccount {
    return {
      balance: this.bonusBalance(),
      transactions: [...this.bonusLedger]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map((t) => ({ ...t })),
    };
  }

  /** баланс: SUM(accrual) − SUM(spend) от источника-ledger */
  private bonusBalance(): number {
    return this.bonusLedger.reduce(
      (s, r) => s + (r.kind === 'accrual' ? r.amount : -r.amount),
      0,
    );
  }

  /** запись в ledger; дубль (booking_id + reason) молча игнорируется */
  private pushBonus(row: {
    kind: BonusKind;
    reason: BonusReason;
    amount: number;
    bookingId: string;
  }): void {
    const dup = this.bonusLedger.some(
      (r) => r.bookingId === row.bookingId && r.reason === row.reason,
    );
    if (dup) return;
    this.bonusLedger.push({
      id: `demo-bonus-${++this.bonusSeq}`,
      createdAt: new Date().toISOString(),
      ...row,
    });
  }

  /** разворот бонусов отменённой брони — как reverseBookingBonuses в API */
  private reverseBookingBonuses(booking: Booking): void {
    const rows = this.bonusLedger.filter((r) => r.bookingId === booking.id);
    const spent = rows.find((r) => r.reason === 'payment')?.amount;
    if (spent) {
      this.pushBonus({
        kind: 'accrual',
        reason: 'refund',
        amount: spent,
        bookingId: booking.id,
      });
    }
    const cashback = rows.find((r) => r.reason === 'cashback')?.amount;
    if (cashback) {
      const amount = Math.min(cashback, Math.max(this.bonusBalance(), 0));
      if (amount > 0) {
        this.pushBonus({
          kind: 'spend',
          reason: 'clawback',
          amount,
          bookingId: booking.id,
        });
      }
    }
  }

  // ── Лист ожидания: честная гонка в миниатюре ────────────────────────
  // Как waitlist_entries + api.waitlist.released в API: очередь по
  // queuedAt, уведомление голове при освобождении места, место НЕ
  // резервируется. «Письмо» демо не пишет — уведомление видно статусом
  // NOTIFIED в /my и всплывашкой (стор ловит переход по onChange).

  /** позиция среди WAITING сеанса (1 — голова); null — уже не в очереди */
  private toWaitlistDto(entry: DemoWaitlistEntry): WaitlistEntry {
    const queue = this.waitlistQueue(entry.sessionId);
    const position = queue.findIndex((w) => w.id === entry.id) + 1;
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      userId: entry.userId,
      status: entry.status,
      position: position || null,
      queuedAt: entry.queuedAt,
      notifiedAt: entry.notifiedAt,
      createdAt: entry.createdAt,
    };
  }

  /** очередь сеанса: WAITING от старейшей к новой (waitingQueue из API) */
  private waitlistQueue(sessionId: string): DemoWaitlistEntry[] {
    return this.waitlist
      .filter((w) => w.sessionId === sessionId && w.status === 'WAITING')
      .sort(
        (a, b) =>
          a.queuedAt.localeCompare(b.queuedAt) || (a.id < b.id ? -1 : 1),
      );
  }

  /** миниатюра POST /waitlist/:sessionId — гварды как в WaitlistService */
  joinWaitlist(sessionId: string): WaitlistEntry {
    const found = this.findSession(sessionId);
    if (!found) throw new Error('Сеанс не найден');
    if (Date.parse(found.session.startsAt) <= Date.now()) {
      throw new ApiError('HTTP 410', 410, JSON.stringify({
        statusCode: 410,
        error: 'Gone',
        message: 'Сеанс уже начался — лист ожидания закрыт',
        code: 'sessionPassed',
      }));
    }
    if (this.occupiedFor(sessionId).size < HALL_CAPACITY) {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: 'На сеансе есть свободные места — лист ожидания не нужен',
        code: 'sessionNotFull',
      }));
    }
    // демо без JWT: записи «гостя демо» (как гостевые брони и отзывы)
    const existing = this.waitlist.find(
      (w) => w.sessionId === sessionId && w.userId === DEMO_GUEST_ID,
    );
    if (existing?.status === 'WAITING') {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: 'Вы уже в листе ожидания этого сеанса',
        code: 'waitlistAlready',
      }));
    }
    const now = new Date().toISOString();
    if (existing) {
      // повторный вход после NOTIFIED/LEFT — в конец очереди
      existing.status = 'WAITING';
      existing.queuedAt = now;
      existing.notifiedAt = null;
      this.notify();
      return this.toWaitlistDto(existing);
    }
    const entry: DemoWaitlistEntry = {
      id: uuid(),
      sessionId,
      userId: DEMO_GUEST_ID,
      status: 'WAITING',
      queuedAt: now,
      notifiedAt: null,
      createdAt: now,
    };
    this.waitlist.push(entry);
    this.notify();
    return this.toWaitlistDto(entry);
  }

  /** миниатюра DELETE /waitlist/:sessionId (404 — записи нет) */
  leaveWaitlist(sessionId: string): void {
    const existing = this.waitlist.find(
      (w) => w.sessionId === sessionId && w.userId === DEMO_GUEST_ID,
    );
    if (!existing || existing.status === 'LEFT') {
      throw new ApiError('HTTP 404', 404, JSON.stringify({
        statusCode: 404,
        error: 'Not Found',
        message: 'Запись в листе ожидания не найдена',
        code: 'waitlistEntryNotFound',
      }));
    }
    existing.status = 'LEFT';
    this.notify();
  }

  /** миниатюра GET /waitlist/my: активные записи по будущим сеансам */
  myWaitlist(): MyWaitlistEntry[] {
    return this.waitlist
      .filter((w) => w.userId === DEMO_GUEST_ID && w.status !== 'LEFT')
      .map((w) => {
        const found = this.findSession(w.sessionId)!;
        return {
          ...this.toWaitlistDto(w),
          movieId: found.movie.id,
          movieTitle: found.movie.title,
          hall: found.session.hall,
          startsAt: found.session.startsAt,
        };
      })
      .filter((w) => Date.parse(w.startsAt) > Date.now())
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  }

  /** места освободились — уведомить голову (консьюмер api.waitlist.released) */
  private releaseWaitlist(sessionId: string): void {
    const head = this.waitlistQueue(sessionId)[0];
    if (!head) return;
    head.status = 'NOTIFIED';
    head.notifiedAt = new Date().toISOString();
  }

  // ── QR-билеты: симуляция производной брони ─────────────────────────
  // Как GET /bookings/:id/tickets в API, движок ничего не хранит: билеты
  // выводятся из статуса брони и подписываются DEMO_TICKETS_SECRET
  // (не dev-секрет стенда — подписи демо и live не взаимозаменяемы).

  /** билеты брони: по одному на место; всё, что не CONFIRMED — 409 */
  tickets(bookingId: string): Ticket[] {
    const booking = this.bookings.find((b) => b.id === bookingId);
    if (!booking) {
      throw new ApiError('HTTP 404', 404, JSON.stringify({
        statusCode: 404,
        error: 'Not Found',
        message: 'Бронь не найдена',
      }));
    }
    if (booking.status !== 'CONFIRMED') {
      throw new ApiError('HTTP 409', 409, JSON.stringify({
        statusCode: 409,
        error: 'Conflict',
        message: `Билеты выдаются только по подтверждённой брони (сейчас: ${booking.status})`,
        code: 'bookingNotConfirmed',
        status: booking.status,
      }));
    }
    return booking.seats.map((seat) => {
      const canonical = ticketCanonical(booking.id, seat, booking.sessionAt);
      return {
        bookingId: booking.id,
        seat,
        ticketNo: ticketNoOf(canonical),
        signature: signTicket(canonical),
        movieTitle: booking.movieTitle,
        movieHue: booking.movieHue,
        movieGenreIcon: booking.movieGenreIcon,
        sessionAt: booking.sessionAt,
        hall: booking.hall,
        customerName: booking.customerName,
      };
    });
  }

  /** сканер на входе: тот же вердикт с причиной, что POST /bookings/tickets/verify */
  verifyTicket(payload: string): TicketVerifyResult {
    const none = {
      reason: null,
      bookingId: null,
      seat: null,
      movieTitle: null,
      sessionAt: null,
      hall: null,
      customerName: null,
    } satisfies Omit<TicketVerifyResult, 'valid'>;
    const parsed = parseTicketQr(payload);
    if (!parsed) return { valid: false, ...none, reason: 'malformedPayload' };
    if (!ticketSignatureMatches(parsed.canonical, parsed.signature)) {
      return { valid: false, ...none, reason: 'badSignature', bookingId: parsed.bookingId, seat: parsed.seat };
    }
    const booking = this.bookings.find((b) => b.id === parsed.bookingId);
    if (!booking) {
      return { valid: false, ...none, reason: 'bookingNotFound', bookingId: parsed.bookingId, seat: parsed.seat };
    }
    if (booking.status !== 'CONFIRMED') {
      return { valid: false, ...none, reason: 'bookingNotConfirmed', bookingId: booking.id, seat: parsed.seat };
    }
    if (!booking.seats.includes(parsed.seat)) {
      return { valid: false, ...none, reason: 'seatMismatch', bookingId: booking.id, seat: parsed.seat };
    }
    const context = {
      bookingId: booking.id,
      seat: parsed.seat,
      movieTitle: booking.movieTitle,
      sessionAt: booking.sessionAt,
      hall: booking.hall,
    };
    if (Date.parse(booking.sessionAt) < Date.now()) {
      return { valid: false, ...none, reason: 'sessionPassed', ...context };
    }
    return { valid: true, ...none, ...context, customerName: booking.customerName };
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
    // КиноСоветник: отзыв — сигнал сильнее брони, рейтинг взвешивает жанр
    this.pushSignal({
      movieId,
      genre: movie.genre,
      kind: 'review',
      rating: payload.rating,
      dedupKey: `review:${review.id}`,
    });
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
