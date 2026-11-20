import { DetectiveClient } from './detective.client';

/**
 * Юнит gRPC-клиента без живого сервиса: главное — контракт реально
 * загружается из .proto (резолвинг путей jest/dist), а запрос на
 * недоступный адрес предсказуемо ломается по дедлайну, а не виснет.
 * Порт 9 (discard) никто не слушает; дедлайн укорочен через env.
 */

describe('DetectiveClient (unit)', () => {
  beforeAll(() => {
    process.env.GRPC_DETECTIVE_URL = '127.0.0.1:9';
    process.env.GRPC_DETECTIVE_TIMEOUT_MS = '250';
  });

  afterAll(() => {
    delete process.env.GRPC_DETECTIVE_URL;
    delete process.env.GRPC_DETECTIVE_TIMEOUT_MS;
  });

  it('строится по .proto и падает по дедлайну на мёртвом адресе', async () => {
    const client = new DetectiveClient();

    await expect(
      client.score({
        bookingId: 'b-1',
        userId: 'u-1',
        sessionId: 's-1',
        seatsCount: 2,
        totalRub: 800,
        accountAgeDays: 30,
        bookings24h: 0,
        cancels24h: 0,
        failed24h: 0,
      }),
    ).rejects.toThrow();
  }, 5000);

  it('резолв летит тем же дедлайном — не зависает', async () => {
    const client = new DetectiveClient();

    await expect(
      client.resolve({
        bookingId: 'b-1',
        action: 'approve',
        resolvedBy: 'admin@test.local',
      }),
    ).rejects.toThrow();
  }, 5000);
});
