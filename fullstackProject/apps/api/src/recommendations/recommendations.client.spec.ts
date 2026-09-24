import { RecommendationsClient } from './recommendations.client';

/**
 * Юнит gRPC-клиента без живого сервиса: главное — контракт реально
 * загружается из .proto (резолвинг путей jest/dist), а запрос на
 * недоступный адрес предсказуемо ломается по дедлайну, а не виснет.
 * Порт 9 (discard) никто не слушает; дедлайн укорочен через env.
 */

describe('RecommendationsClient (unit)', () => {
  beforeAll(() => {
    process.env.GRPC_RECOMMENDATION_URL = '127.0.0.1:9';
    process.env.GRPC_RECOMMENDATION_TIMEOUT_MS = '250';
  });

  afterAll(() => {
    delete process.env.GRPC_RECOMMENDATION_URL;
    delete process.env.GRPC_RECOMMENDATION_TIMEOUT_MS;
  });

  it('строится по .proto и падает по дедлайну на мёртвом адресе', async () => {
    const client = new RecommendationsClient();

    await expect(
      client.forUser('user-1', [
        { movieId: 'm1', title: 'Дюна', genre: 'фантастика', ratingAvg: 3, ratingCount: 3 },
      ]),
    ).rejects.toThrow();
  }, 5000);
});
