import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { Booking } from './booking.entity';
import { BookingsService } from './bookings.service';
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
    seats: 3,
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
  let bookingsRepo: { save: jest.Mock; find: jest.Mock; findOneByOrFail: jest.Mock; create: jest.Mock; createQueryBuilder: jest.Mock };
  let moviesRepo: { findOneByOrFail: jest.Mock };
  let rabbit: { publish: jest.Mock };

  beforeEach(async () => {
    bookingsRepo = {
      create: jest.fn((x) => ({ ...bookingFixture(), ...x })),
      save: jest.fn(async (x) => x),
      find: jest.fn(),
      findOneByOrFail: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    moviesRepo = { findOneByOrFail: jest.fn(async () => movieFixture) };
    rabbit = { publish: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
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
        seats: 3,
      };

      const result = await service.create(dto);

      expect(result.status).toBe('PENDING');
      expect(result.totalRub).toBe(1200); // 400 × 3
      expect(result.movieTitle).toBe('Рекурсия');
      expect(result.seats).toBe(3);
    });

    it('публикует booking.created в обмен cinema', async () => {
      await service.create({
        movieId: 'movie-1',
        customerName: 'Дмитрий',
        seats: 3,
      });

      expect(rabbit.publish).toHaveBeenCalledTimes(1);
      const [exchange, routingKey, event] = rabbit.publish.mock.calls[0];
      expect(exchange).toBe('cinema');
      expect(routingKey).toBe('booking.created');
      expect(event).toMatchObject({
        bookingId: 'booking-1',
        movieTitle: 'Рекурсия',
        seats: 3,
        totalRub: 1200,
      });
    });

    it('обрезает пробелы вокруг имени', async () => {
      const result = await service.create({
        movieId: 'movie-1',
        customerName: '  Дмитрий  ',
        seats: 1,
      });
      expect(result.customerName).toBe('Дмитрий');
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
    });
  });
});
