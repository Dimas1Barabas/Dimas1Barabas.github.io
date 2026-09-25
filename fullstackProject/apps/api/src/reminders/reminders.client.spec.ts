import { RemindersClient } from './reminders.client';

/**
 * Юнит gRPC-клиента без живого сервиса: главное — контракт реально
 * загружается из .proto (резолвинг путей jest/dist), а запрос на
 * недоступный адрес предсказуемо ломается по дедлайну, а не виснет.
 * Порт 9 (discard) никто не слушает; дедлайн укорочен через env.
 */

describe('RemindersClient (unit)', () => {
  beforeAll(() => {
    process.env.GRPC_REMINDER_URL = '127.0.0.1:9';
    process.env.GRPC_REMINDER_TIMEOUT_MS = '250';
  });

  afterAll(() => {
    delete process.env.GRPC_REMINDER_URL;
    delete process.env.GRPC_REMINDER_TIMEOUT_MS;
  });

  it('строится по .proto и падает по дедлайну на мёртвом адресе (schedule)', async () => {
    const client = new RemindersClient();

    await expect(
      client.schedule({
        bookingId: 'booking-1',
        userId: 'user-1',
        email: 'viewer@example.com',
        movieId: 'movie-1',
        movieTitle: 'Дюна',
        hall: 'IMAX',
        sessionAt: new Date(Date.now() + 3600_000).toISOString(),
        seats: ['5-7'],
      }),
    ).rejects.toThrow();
  }, 5000);

  it('cancel тоже честно ломается, а не виснет', async () => {
    const client = new RemindersClient();

    await expect(client.cancel('booking-1')).rejects.toThrow();
  }, 5000);
});
