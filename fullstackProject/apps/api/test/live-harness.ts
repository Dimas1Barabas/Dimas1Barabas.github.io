/**
 * Live-int harness: приложение целиком — как в проде — против одноразовых
 * контейнеров testcontainers (PostgreSQL + Redis + RabbitMQ). Зеркало
 * Go-паттерна из 15-A: TESTCONTAINERS=1 (CI) — контейнеры поднимаются,
 * локально переменную не ставим — спеки честно скипаются (describeLive),
 * машина разработчика контейнеры не трогает.
 *
 * Чем отличается от int-harness: никакой фантазии про хранилища — миграции
 * гоняются по-настоящему (migrationsRun), сиды сеет onModuleInit, гонки за
 * места решает реальный uq-констрейнт, статистика — реальный GROUP BY,
 * вердикты воркера едет по реальному брокеру. Фейками остаются только
 * четыре gRPC-клиента Go-сервисов — сама интеграция с ними это уровень
 * живого стенда (15-C).
 *
 * ГРАБЛИ, из-за которых harness устроен именно так:
 *  - uri RabbitMQ и DATABASE_URL вычисляются НА ИМПОРТЕ модулей
 *    (rabbitmq.config.ts, data-source.ts), поэтому AppModule импортируется
 *    динамически — строго после того, как liveInfra() выставил process.env;
 *  - у каждого тест-файла свой module-registry, поэтому singleton контейнеров
 *    живёт в globalThis, а не в module scope — все файлы одного jest-процесса
 *    (--runInBand) делят одну тройку контейнеров;
 *  - jest между файлами registry обнуляет, но процесс один: контейнеры
 *    переживают файлы и умирают вместе с jest (Ryuk-жнецом подчищается).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
import * as amqp from 'amqplib';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PricingClient } from '../src/pricing/pricing.client';
import { RateLimiterClient } from '../src/ratelimiter/ratelimiter.client';
import { RecommendationsClient } from '../src/recommendations/recommendations.client';
import { RemindersClient } from '../src/reminders/reminders.client';
import { MoviesService } from '../src/movies/movies.service';
import { UsersService } from '../src/users/users.service';

/** гейт по образцу Go: живой прогон делает CI-робот, локально — скип */
export const liveEnabled = process.env.TESTCONTAINERS === '1';
export const describeLive = liveEnabled ? describe : describe.skip;

export interface LiveInfra {
  /** postgres://… контейнера — уже присвоен в process.env.DATABASE_URL */
  pgUri: string;
  /** redis://… контейнера — уже присвоен в process.env.REDIS_URL */
  redisUrl: string;
  /** amqp://… контейнера — уже присвоен в process.env.RABBITMQ_URL */
  amqpUrl: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __liveInfra: Promise<LiveInfra> | undefined;
}

/** Singleton-инфраструктура: одна тройка контейнеров на jest-процесс */
export function liveInfra(): Promise<LiveInfra> {
  globalThis.__liveInfra ??= startInfra();
  return globalThis.__liveInfra;
}

async function startInfra(): Promise<LiveInfra> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const { RedisContainer } = await import('@testcontainers/redis');
  const { RabbitMQContainer } = await import('@testcontainers/rabbitmq');

  // образы — как в docker-compose стенда, чтобы CI валидиров то, что летит в прод
  const [pg, redis, rabbit] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').withDatabase('cine').start(),
    new RedisContainer('redis:7-alpine').start(),
    new RabbitMQContainer('rabbitmq:3.13-alpine').start(),
  ]);

  const infra: LiveInfra = {
    pgUri: pg.getConnectionUri(),
    redisUrl: redis.getConnectionUrl(),
    amqpUrl: rabbit.getAmqpUrl(),
  };
  // ДО динамического импорта AppModule: uri-константы фиксируются при
  // загрузке модулей (см. комментарий в шапке)
  process.env.DATABASE_URL = infra.pgUri;
  process.env.REDIS_URL = infra.redisUrl;
  process.env.RABBITMQ_URL = infra.amqpUrl;
  return infra;
}

/** каталог из /api/movies (DTO с sessions[]) */
export type MovieDtoJson = {
  id: string;
  title: string;
  priceRub: number;
  sessions: { id: string; hall: string; startsAt: string }[];
};

/** контекст live-спека: приложение на живой инфраструктуре */
export interface LiveAppContext {
  app: INestApplication;
  /** живой DataSource приложения — прямые SELECT для проверок строк */
  db: DataSource;
  /** Authorization: владелец брони, чужак и администратор (живые JWT) */
  bearer: string;
  bearerB: string;
  bearerAdmin: string;
  catalog: () => Promise<MovieDtoJson[]>;
  /** подождать, пока бронь не окажется в одном из статусов (вердикт воркера) */
  waitBookingStatus: (bookingId: string, statuses: string[], timeoutMs?: number) => Promise<any>;
}

/**
 * Поднимает AppModule целиком: миграции (migrationsRun), сиды каталога
 * и админа, топология RabbitMQ, коннекты Redis — весь boot-путь прод-старта,
 * кроме listen. Затем приводит состояние в «чистый лист» для своего
 * спек-файла: TRUNCATE всех доменных таблиц, FLUSHALL Redis, purge очередей
 * и повторный посев каталога/админа (onModuleInit-методы идемпотентны).
 */
export async function buildLiveApp(): Promise<LiveAppContext> {
  await liveInfra(); // env на месте — теперь можно импортировать приложение
  const { AppModule } = await import('../src/app.module');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    // Go-сервисы не поднимаем: их поведение — уровень живого стенда (15-C).
    // Фейки повторяют int-harness, чтобы live-спеки не зависели от соседей
    .overrideProvider(PricingClient)
    .useValue({
      quote: async (input: { basePriceRub: number }) => ({
        priceRub: input.basePriceRub,
        basePriceRub: input.basePriceRub,
        factors: [],
        occupied: 0,
        capacity: 80,
      }),
    })
    .overrideProvider(RateLimiterClient)
    .useValue({ check: async () => ({ allowed: true }) })
    .overrideProvider(RemindersClient)
    .useValue({
      schedule: async () => ({ status: 'SCHEDULED', dueAt: new Date(Date.now() + 3600_000).toISOString() }),
      cancel: async () => ({ status: 'CANCELLED' }),
    })
    .overrideProvider(RecommendationsClient)
    .useValue({ forUser: async () => ({ items: [], basis: 'empty' }) })
    .compile();

  const app = moduleRef.createNestApplication();
  // обвязка 1:1 с main.ts (кроме listen/CORS/swagger)
  app.setGlobalPrefix('api');
  app.useWebSocketAdapter(new WsAdapter(app));
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init(); // миграции + сиды + rabbit-топология + коннекты

  const db = app.get(DataSource);
  await resetLiveState(db, await liveInfra());

  const moviesService = app.get(MoviesService);
  const usersService = app.get(UsersService);
  await moviesService.onModuleInit(); // свежий каталог для этого файла
  await usersService.onModuleInit(); // свежий админ для этого файла

  const bearer = await registerAndLogin(app, 'a@live.test', 'Анна Живая');
  const bearerB = await registerAndLogin(app, 'b@live.test', 'Борис Чужой');
  const bearerAdmin = await loginAdmin(app);

  const catalog = async () => {
    const res = await request(app.getHttpServer()).get('/api/movies');
    return res.body.data as MovieDtoJson[];
  };

  const waitBookingStatus = async (
    bookingId: string,
    statuses: string[],
    timeoutMs = 15_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await request(app.getHttpServer())
        .get('/api/bookings/my')
        .set('Authorization', bearer);
      const mine: any[] = res.body;
      const found = mine?.find((b) => b.id === bookingId);
      if (found && statuses.includes(found.status)) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `Бронь ${bookingId} не пришла к ${statuses.join('/')} за ${timeoutMs}мс (сейчас: ${found?.status ?? 'нет в кабинете'})`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  return { app, db, bearer, bearerB, bearerAdmin, catalog, waitBookingStatus };
}

/** Все доменные таблицы схемы (migrations не трогаем) */
const TRUNCATE_SQL = `TRUNCATE TABLE
  bookings, seat_occupancy, bonus_transactions, waitlist_entries, promos,
  reviews, refresh_tokens, password_resets, sessions, movies, users
  RESTART IDENTITY CASCADE`;

/** Очереди из rabbitmq.config: рабочие с retry/parking + wait-очередь резерва */
const PURGE_QUEUES = [
  'api.booking.processed',
  'api.booking.refunded',
  'api.booking.expired',
  'api.waitlist.released',
  'api.recommendations.signals',
  'api.reminder.sent',
].flatMap((q) => [q, `${q}.retry`, `${q}.parking`]).concat('booking.payment.wait');

/** Чистый лист между спек-файлами: одна база/брокер на процесс */
export async function resetLiveState(db: DataSource, infra: LiveInfra): Promise<void> {
  await db.query(TRUNCATE_SQL);

  const redis = new Redis(infra.redisUrl);
  await redis.flushall();
  redis.disconnect();

  const conn = await amqp.connect(infra.amqpUrl);
  const ch = await conn.createChannel();
  for (const queue of PURGE_QUEUES) {
    try {
      await ch.purgeQueue(queue);
    } catch {
      // очередь ещё не объявлена (первый файл, до init приложения) — нечего чистить
    }
  }
  await conn.close();
}

/** Регистрация + логин = живой JWT (bcrypt → TokensService) */
async function registerAndLogin(app: INestApplication, email: string, name: string): Promise<string> {
  await request(app.getHttpServer()).post('/api/auth/register').send({
    email,
    password: 'password-1',
    name,
  });
  const res = await request(app.getHttpServer()).post('/api/auth/login').send({
    email,
    password: 'password-1',
  });
  return `Bearer ${res.body.accessToken}`;
}

/** адмира сеет UsersService.onModuleInit при пустой таблице users */
async function loginAdmin(app: INestApplication): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/auth/login').send({
    email: 'admin@cine.local',
    password: 'admin-secret-1',
  });
  return `Bearer ${res.body.accessToken}`;
}
