/**
 * BookingsService (unit): витрины: list, my, stats, seatMap.
 * Общий харнесс — фикстуры и фейки репозиториев/шин — в
 * ./bookings.service.harness; каждый домен деструктурирует нужное.
 */

import { buildBookingsHarness, type BookingsHarness, authUser, bookingFixture } from './bookings.service.harness';

describe('BookingsService: витрины: list, my, stats, seatMap (unit)', () => {
  let service: BookingsHarness['service'];
  let bookingsRepo: BookingsHarness['bookingsRepo'];
  let sessionsRepo: BookingsHarness['sessionsRepo'];
  let occupancyRepo: BookingsHarness['occupancyRepo'];

  beforeEach(async () => {
    ({ service, bookingsRepo, sessionsRepo, occupancyRepo } = await buildBookingsHarness());
  });

  describe('list', () => {
    it('возвращает DTO с данными фильма и сеанса', async () => {
      bookingsRepo.find.mockResolvedValue([bookingFixture()]);

      const result = await service.list();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'booking-1',
        movieTitle: 'Рекурсия',
        movieHue: 275,
        movieGenreIcon: '🌀',
        sessionId: 'session-1',
        hall: 'IMAX',
        status: 'PENDING',
      });
    });
  });

  describe('my', () => {
    it('отбирает брони по владельцу из JWT и маппит в DTO', async () => {
      bookingsRepo.find.mockResolvedValue([bookingFixture()]);

      const result = await service.my(authUser);

      expect(bookingsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'booking-1', userId: 'user-1' });
    });

    it('у пользователя без броней — пустой список', async () => {
      bookingsRepo.find.mockResolvedValue([]);

      await expect(service.my(authUser)).resolves.toEqual([]);
    });
  });

  describe('stats', () => {
    it('считает брони по статусам, заполняя нули', async () => {
      bookingsRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { status: 'CONFIRMED', count: '2' },
          { status: 'PENDING', count: '1' },
          { status: 'CANCELLED', count: '3' },
        ]),
      });

      const result = await service.stats();

      expect(result).toEqual({
        PENDING_PAYMENT: 0,
        PENDING: 1,
        CONFIRMED: 2,
        FAILED: 0,
        EXPIRED: 0,
        CANCELLING: 0,
        CANCELLED: 3,
      });
    });
  });

  describe('seatMap', () => {
    it('отдаёт занятые места сеанса, геометрию зала и счётчик свободных', async () => {
      occupancyRepo.find.mockResolvedValue([
        { seat: '5-7' },
        { seat: '1-1' },
      ]);

      const map = await service.seatMap('session-1');

      expect(sessionsRepo.findOneByOrFail).toHaveBeenCalledWith({
        id: 'session-1',
      });
      expect(map.sessionId).toBe('session-1');
      expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
      expect(map.occupied).toEqual(['1-1', '5-7']); // сортировка по залу
      expect(map.free).toBe(80 - 2);
    });
  });
});
