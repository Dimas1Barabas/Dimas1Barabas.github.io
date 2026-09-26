import { RateLimiterClient } from './ratelimiter.client';

/**
 * Юнит gRPC-клиента без живого сервиса: главное — контракт реально
 * загружается из .proto (резолвинг путей jest/dist), а запрос на
 * недоступный адрес предсказуемо ломается по дедлайну, а не виснет.
 * Порт 9 (discard) никто не слушает; дедлайн укорочен через env.
 */

describe('RateLimiterClient (unit)', () => {
  beforeAll(() => {
    process.env.GRPC_RATELIMITER_URL = '127.0.0.1:9';
    process.env.GRPC_RATELIMITER_TIMEOUT_MS = '250';
  });

  afterAll(() => {
    delete process.env.GRPC_RATELIMITER_URL;
    delete process.env.GRPC_RATELIMITER_TIMEOUT_MS;
  });

  it('строится по .proto и падает по дедлайну на мёртвом адресе', async () => {
    const client = new RateLimiterClient();

    await expect(
      client.check({ action: 'bookings.create', key: 'user-1' }),
    ).rejects.toThrow();
  }, 5000);
});
