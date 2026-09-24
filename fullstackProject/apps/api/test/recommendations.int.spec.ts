import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { MoviesService } from '../src/movies/movies.service';
import { RecommendationsClient } from '../src/recommendations/recommendations.client';
import { RecommendationsConsumer } from '../src/recommendations/recommendations.consumer';
import { RecommendationsController } from '../src/recommendations/recommendations.controller';
import { RecommendationsService } from '../src/recommendations/recommendations.service';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_CLIENT } from '../src/redis/redis.tokens';

/**
 * Интеграционный тест рекомендаций: реальный HTTP-стек Nest (роутинг,
 * JWT-гвард, контроллер → сервис → кэш), gRPC-клиент и каталог — фейки.
 * Кэш — настоящий RedisService поверх Map: проверяем и попадание,
 * и гашение консьюмером сигналов.
 */

describe('Рекомендации: HTTP-интеграция (фейковые зависимости)', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let recos: { forUser: jest.Mock };
  let redisStore: Map<string, string>;
  let bearer: string;

  beforeAll(async () => {
    recos = { forUser: jest.fn() };
    redisStore = new Map();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [RecommendationsController],
      providers: [
        RecommendationsService,
        RecommendationsConsumer,
        RedisService,
        { provide: REDIS_CLIENT, useValue: redisFake(redisStore) },
        { provide: RecommendationsClient, useValue: recos },
        {
          provide: MoviesService,
          useValue: {
            findAll: jest.fn(async () => ({
              source: 'db',
              data: [
                {
                  id: 'movie-1',
                  title: 'Дюна',
                  genre: 'фантастика',
                  ratingAvg: 3,
                  ratingCount: 3,
                },
              ],
            })),
          },
        },
        { provide: ConfigService, useValue: { get: (_k: string, def?: string) => def } },
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    const jwt = moduleRef.get(JwtService);
    bearer = `Bearer ${await jwt.signAsync({
      sub: 'user-a',
      email: 'anna@test.local',
      name: 'Анна Тест',
      role: 'user',
    })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    recos.forUser.mockReset();
    redisStore.clear();
  });

  it('без токена — 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/recommendations/my');

    expect(res.status).toBe(401);
  });

  it('200: топ с basis и причиной; кандидаты — текущая афиша', async () => {
    recos.forUser.mockResolvedValue({
      basis: 'profile',
      items: [
        { movieId: 'movie-1', title: 'Дюна', genre: 'фантастика', score: 0.88, reason: 'вы часто смотрите «фантастику»' },
      ],
    });

    const res = await request(app.getHttpServer())
      .get('/api/recommendations/my')
      .set('Authorization', bearer);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      basis: 'profile',
      items: [
        { movieId: 'movie-1', title: 'Дюна', genre: 'фантастика', score: 0.88, reason: 'вы часто смотрите «фантастику»' },
      ],
    });
    const [userId, candidates, limit] = recos.forUser.mock.calls[0];
    expect(userId).toBe('user-a');
    expect(limit).toBe(4);
    expect(candidates).toEqual([
      { movieId: 'movie-1', title: 'Дюна', genre: 'фантастика', ratingAvg: 3, ratingCount: 3 },
    ]);
  });

  it('КиноСоветник недоступен — 200 с basis unavailable (витрина не падает)', async () => {
    recos.forUser.mockRejectedValue(new Error('UNAVAILABLE: connect ECONNREFUSED'));

    const res = await request(app.getHttpServer())
      .get('/api/recommendations/my')
      .set('Authorization', bearer);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], basis: 'unavailable' });
  });

  it('кэш 60 c: повторный запрос не ходит в gRPC', async () => {
    recos.forUser.mockResolvedValue({ basis: 'popular', items: [] });

    const first = await request(app.getHttpServer())
      .get('/api/recommendations/my')
      .set('Authorization', bearer);
    const second = await request(app.getHttpServer())
      .get('/api/recommendations/my')
      .set('Authorization', bearer);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(recos.forUser).toHaveBeenCalledTimes(1);
  });

  it('сигнал зрителя (консьюмер) гасит кэш — следующий запрос свежий', async () => {
    recos.forUser.mockResolvedValue({ basis: 'popular', items: [] });

    await request(app.getHttpServer())
      .get('/api/recommendations/my')
      .set('Authorization', bearer);

    const consumer = app.get(RecommendationsConsumer);
    await consumer.onSignal({
      userId: 'user-a',
      movieId: 'movie-1',
      movieTitle: 'Дюна',
      genre: 'фантастика',
      bookingId: 'booking-1',
      occurredAt: new Date().toISOString(),
    });

    await request(app.getHttpServer())
      .get('/api/recommendations/my')
      .set('Authorization', bearer);

    expect(recos.forUser).toHaveBeenCalledTimes(2);
  });
});

/** Map-фейк ioredis-клиента (как в http.int.spec) */
function redisFake(store: Map<string, string>) {
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (...keys: string[]) => {
      keys.forEach((k) => store.delete(k));
    },
    ping: async () => 'PONG',
  };
}
