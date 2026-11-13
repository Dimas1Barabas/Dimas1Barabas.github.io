/**
 * Live-int harness: приложение целиком — как в проде — против одноразовых
 * контейнеров testcontainers (PostgreSQL + Redis + RabbitMQ + SeaweedFS —
 * S3-постеры этапа 29; Meilisearch — поиск этапа 30). Зеркало
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
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
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
import { SearchService } from '../src/search/search.service';

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
  /** http://host:mapped-port S3-шлюза SeaweedFS — в S3_ENDPOINT (этап 29) */
  s3Endpoint: string;
  /** http://host:mapped-port Meilisearch — в MEILI_HOST (этап 30) */
  meiliUrl: string;
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
  const { GenericContainer } = await import('testcontainers');
  const { Wait } = await import('testcontainers');
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  // образы — как в docker-compose стенда, чтобы CI валидиров то, что летит в прод.
  // SeaweedFS — зеркало compose-сервиса: тот же образ, команда и s3.json
  // с identity cine (путь — от test/ вверх до seaweedfs/ репозитория)
  const seaweedfs = new GenericContainer('chrislusf/seaweedfs:4.53')
    .withCommand([
      'server',
      '-ip.bind=0.0.0.0',
      '-dir=/data',
      '-master.volumeSizeLimitMB=1024',
      '-s3',
      '-s3.port=8333',
      '-s3.config=/etc/seaweedfs/s3.json',
    ])
    .withCopyContentToContainer([
      {
        content: readFileSync(
          resolve(__dirname, '../../../seaweedfs/s3.json'),
          'utf8',
        ),
        target: '/etc/seaweedfs/s3.json',
      },
    ])
    // 9333 — мастер (готовность /readyz), 8333 — сам S3-шлюз
    .withExposedPorts(8333, 9333)
    .withWaitStrategy(Wait.forHttp('/readyz', 9333));

  // Meilisearch — зеркало compose-сервиса: тот же образ, production-режим
  // с мастер-ключом (этап 30); готовность — публичный /health без ключа
  const meilisearch = new GenericContainer('getmeili/meilisearch:v1.56.2')
    .withEnvironment({
      MEILI_ENV: 'production',
      MEILI_MASTER_KEY: 'cine-meili-master-secret',
      MEILI_NO_ANALYTICS: 'true',
    })
    .withExposedPorts(7700)
    .withWaitStrategy(Wait.forHttp('/health', 7700));

  const [pg, redis, rabbit, s3, meili] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').withDatabase('cine').start(),
    new RedisContainer('redis:7-alpine').start(),
    new RabbitMQContainer('rabbitmq:3.13-alpine').start(),
    seaweedfs.start(),
    meilisearch.start(),
  ]);

  const infra: LiveInfra = {
    pgUri: pg.getConnectionUri(),
    redisUrl: redis.getConnectionUrl(),
    amqpUrl: rabbit.getAmqpUrl(),
    s3Endpoint: `http://${s3.getHost()}:${s3.getMappedPort(8333)}`,
    meiliUrl: `http://${meili.getHost()}:${meili.getMappedPort(7700)}`,
  };
  // ДО динамического импорта AppModule: uri-константы фиксируются при
  // загрузке модулей (см. комментарий в шапке). S3-переменные читает
  // PostersModule на сборке DI — тоже до импорта; MEILI_* — SearchModule
  process.env.DATABASE_URL = infra.pgUri;
  process.env.REDIS_URL = infra.redisUrl;
  process.env.RABBITMQ_URL = infra.amqpUrl;
  process.env.S3_ENDPOINT = infra.s3Endpoint;
  process.env.S3_ACCESS_KEY = 'cine';
  process.env.S3_SECRET_KEY = 'cine-poster-secret';
  process.env.S3_BUCKET = 'cine-posters';
  process.env.MEILI_HOST = infra.meiliUrl;
  process.env.MEILI_API_KEY = 'cine-meili-master-secret';
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
  /** остановить мини-релей outbox (await в afterAll ДО app.close) */
  stopOutboxRelay: () => Promise<void>;
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

  // мини-релей транзакционного outbox: в бою записи из outbox_messages
  // доставляет Курьер (services/outbox-relay), которого в testcontainers-
  // стенде нет — его роль играет этот цикл. Семантика та же: SKIP LOCKED
  // батч → publish (messageId = id записи) → published_at; тик 100мс,
  // чтобы live-спеки не ждали прод-интервал. Публикация — через
  // AmqpConnection приложения, коннект живёт вместе с app.
  const rabbit = app.get(AmqpConnection);
  let relayBusy = false;
  const relayTick = async () => {
    if (relayBusy) return;
    relayBusy = true;
    try {
      for (;;) {
        const rows: {
          id: string;
          routing_key: string;
          payload: object;
          headers: Record<string, string> | null;
        }[] = await db.query(
          `SELECT id, routing_key, payload, headers FROM outbox_messages
           WHERE published_at IS NULL AND next_attempt_at <= now()
           ORDER BY created_at, id LIMIT 10 FOR UPDATE SKIP LOCKED`,
        );
        if (!rows.length) return;
        const now = new Date();
        for (const r of rows) {
          await rabbit.publish('cinema', r.routing_key, r.payload, {
            messageId: r.id,
            headers: r.headers ?? {},
          });
          await db.query(
            `UPDATE outbox_messages SET published_at = $1
             WHERE id = $2 AND published_at IS NULL`,
            [now, r.id],
          );
        }
      }
    } finally {
      relayBusy = false;
    }
  };
  const relayTimer = setInterval(() => {
    void relayTick();
  }, 100);
  // НЕ просто clearInterval: тик в полёте продолжает публиковать, и
  // app.close() закрывает канал под его publish'ами — ChannelWrapper.
  // close() ждёт их подтверждения и падает «Channel closed» (run
  // 13ff20eb: bookings.live-int после зелёных тестов). Ждём дренаж
  const stopOutboxRelay = async (): Promise<void> => {
    clearInterval(relayTimer);
    while (relayBusy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const moviesService = app.get(MoviesService);
  const usersService = app.get(UsersService);
  await moviesService.onModuleInit(); // свежий каталог для этого файла
  await usersService.onModuleInit(); // свежий админ для этого файла
  // TRUNCATE стёр индексированный на app.init() каталог, пересев создал
  // фильмы с новыми uuid — пересобираем индекс (идемпотент: delete-all+add,
  // призраков не остаётся). Без движка (null-стор) — тихий no-op
  await app.get(SearchService).onApplicationBootstrap();

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

  return { app, db, stopOutboxRelay, bearer, bearerB, bearerAdmin, catalog, waitBookingStatus };
}

/** Все доменные таблицы схемы (migrations не трогаем) */
const TRUNCATE_SQL = `TRUNCATE TABLE
  outbox_messages, bookings, seat_occupancy, bonus_transactions, waitlist_entries,
  promos, reviews, refresh_tokens, password_resets, sessions, movies, users
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
