import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Movie } from '../movies/movie.entity';
import { Booking } from './booking.entity';
import { BookingsService } from './bookings.service';
import { SeatOccupancy } from './seat-occupancy.entity';
import { CreateBookingDto } from './dto/create-booking.dto';

const movieFixture: Movie = {
  id: 'movie-1',
  title: 'Рекурсия',
  description: 'desc',
  genre: 'хоррор',
  genreIcon: '🌀',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  sessionAt: new Date('2026-09-05T19:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

function bookingFixture(): Booking {
  return {
    id: 'booking-1',
    movieId: movieFixture.id,
    movie: movieFixture,
    customerName: 'Дмитрий',
    seats: ['5-7', '5-8', '5-9'],
    totalRub: 1200,
    status: 'PENDING',
    message: null,
    processedBy: null,
    processedAt: null,
    createdAt: new Date('2026-09-03T12:00:00Z'),
    updatedAt: new Date('2026-09-03T12:00:00Z'),
  };
}

describe('BookingsService (unit)', () => {
  let service: BookingsService;
  let bookingsRepo: {
    save: jest.Mock;
    find: jest.Mock;
    findOneByOrFail: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let moviesRepo: { findOneByOrFail: jest.Mock };
  let occupancyRepo: { find: jest.Mock; delete: jest.Mock };
  let rabbit: { publish: jest.Mock };
  /** что «INSERT INTO seat_occupancy» сделал внутри транзакции */
  let emInsert: jest.Mock;

  beforeEach(async () => {
    bookingsRepo = {
      // merge с фикстурой эмулирует БД: проставляет createdAt/updatedAt
      save: jest.fn(async (x: Partial<Booking>) => ({ ...bookingFixture(), ...x })),
      find: jest.fn(),
      findOneByOrFail: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    moviesRepo = { findOneByOrFail: jest.fn(async () => movieFixture) };
    occupancyRepo = { find: jest.fn(async () => []), delete: jest.fn() };
    rabbit = { publish: jest.fn() };
    emInsert = jest.fn(async () => undefined);

    // «транзакция» сразу выполняет callback с эмуляцией EntityManager:
    // insert может упасть с pg-кодом 23505 — как настоящий констрейнт
    const em: {
      findOneByOrFail: (entity: unknown, where: { id: string }) => Promise<Movie>;
      create: (entity: unknown, x: Partial<Booking>) => Partial<Booking>;
      save: (entity: unknown, x: Booking) => Promise<Booking>;
      insert: jest.Mock;
    } = {
      findOneByOrFail: (_entity, where) => moviesRepo.findOneByOrFail(where),
      create: (_entity, x) => x,
      save: (_entity, x) => bookingsRepo.save(x),
      insert: emInsert,
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: DataSource, useValue: { transaction: (cb: (e: typeof em) => unknown) => cb(em) } },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(SeatOccupancy), useValue: occupancyRepo },
        { provide: AmqpConnection, useValue: rabbit },
      ],
    }).compile();

    service = moduleRef.get(BookingsService);
  });

  describe('create', () => {
    it('сохраняет PENDING-бронь с рассчитанной суммой', async () => {
      const dto: CreateBookingDto = {
        movieId: 'movie-1',
        customerName: 'Дмитрий',
        seats: ['5-7', '5-8', '5-9'],
      };

      const result = await service.create(dto);

      expect(result.status).toBe('PENDING');
      expect(result.totalRub).toBe(1200); // 400 × 3
      expect(result.movieTitle).toBe('Рекурсия');
      expect(result.seats).toEqual(['5-7', '5-8', '5-9']);
    });

    it('занимает места строками занятости в той же транзакции', async () => {
      await service.create({
        movieId: 'movie-1',
        customerName: 'Дмитрий',
        seats: ['5-7'],
      });

      expect(emInsert).toHaveBeenCalledWith(
        SeatOccupancy,
        expect.arrayContaining([
          expect.objectContaining({ movieId: 'movie-1', seat: '5-7' }),
        ]),
      );
    });

    it('публикует booking.created в обмен cinema', async () => {
      await service.create({
        movieId: 'movie-1',
        customerName: 'Дмитрий',
        seats: ['5-7', '5-8', '5-9'],
      });

      expect(rabbit.publish).toHaveBeenCalledTimes(1);
      const [exchange, routingKey, event] = rabbit.publish.mock.calls[0];
      expect(exchange).toBe('cinema');
      expect(routingKey).toBe('booking.created');
      expect(event).toMatchObject({
        movieTitle: 'Рекурсия',
        seats: ['5-7', '5-8', '5-9'],
        totalRub: 1200,
      });
    });

    it('обрезает пробелы вокруг имени', async () => {
      const result = await service.create({
        movieId: 'movie-1',
        customerName: '  Дмитрий  ',
        seats: ['1-1'],
      });
      expect(result.customerName).toBe('Дмитрий');
    });

    it('409 со списком мест, если констрейнт отбил вставку', async () => {
      // имитируем pg: уникальный констрейнт (movie_id, seat)
      emInsert.mockRejectedValue({ code: '23505' });
      occupancyRepo.find.mockResolvedValue([
        { seat: '5-7', movieId: 'movie-1' },
        { seat: '5-8', movieId: 'movie-1' },
      ]);

      const promise = service.create({
        movieId: 'movie-1',
        customerName: 'Дмитрий',
        seats: ['5-8', '5-7', '6-1'],
      });

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        seatsTaken: ['5-7', '5-8'],
      });
      // событие в очередь не ушло
      expect(rabbit.publish).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('возвращает DTO с данными фильма', async () => {
      bookingsRepo.find.mockResolvedValue([bookingFixture()]);

      const result = await service.list();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'booking-1',
        movieTitle: 'Рекурсия',
        movieHue: 275,
        movieGenreIcon: '🌀',
        status: 'PENDING',
      });
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
        ]),
      });

      const result = await service.stats();

      expect(result).toEqual({ PENDING: 1, CONFIRMED: 2, FAILED: 0 });
    });
  });

  describe('handleProcessed', () => {
    it('применяет вердикт воркера и сохраняет', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(bookingsRepo.save).toHaveBeenCalledTimes(1);
      const saved = bookingsRepo.save.mock.calls[0][0] as Booking;
      expect(saved.status).toBe('CONFIRMED');
      expect(saved.message).toBe('Оплата прошла');
      expect(saved.processedBy).toBe('go-worker-1');
      expect(saved.processedAt).toEqual(new Date('2026-09-03T12:00:05Z'));
      // подтверждённая бронь держит места
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
    });

    it('FAILED — освобождает места брони', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'FAILED',
        message: 'Платёж отклонён',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
    });
  });

  describe('seatMap', () => {
    it('отдаёт занятые места, геометрию зала и счётчик свободных', async () => {
      occupancyRepo.find.mockResolvedValue([
        { seat: '5-7' },
        { seat: '1-1' },
      ]);

      const map = await service.seatMap('movie-1');

      expect(map.movieId).toBe('movie-1');
      expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
      expect(map.occupied).toEqual(['1-1', '5-7']); // сортировка по залу
      expect(map.free).toBe(80 - 2);
    });
  });
});
