import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { Movie } from '../movies/movie.entity';
import {
  BookingCancelledEvent,
  BookingCreatedEvent,
  BookingProcessedEvent,
  BookingRefundedEvent,
} from './booking-events';
import { Booking, BookingDto, BookingStatus, toBookingDto } from './booking.entity';
import {
  applyProcessed,
  applyRefunded,
  computeTotal,
  normalizeSeats,
} from './booking.logic';
import {
  HALL_CAPACITY,
  HALL_ROWS,
  HALL_SEATS_PER_ROW,
  SeatMapDto,
  compareSeats,
} from './hall';
import { SeatOccupancy } from './seat-occupancy.entity';
import { CreateBookingDto } from './dto/create-booking.dto';

/**
 * Сигнал «место уже занято», проброшенный из транзакции наружу —
 * там он обогащается списком конфликтных мест и становится 409.
 */
class SeatsTakenError extends Error {
  constructor() {
    super('Места уже заняты');
  }
}

/** unique_violation в Postgres */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Booking)
    private readonly bookings: Repository<Booking>,
    @InjectRepository(Movie)
    private readonly movies: Repository<Movie>,
    @InjectRepository(SeatOccupancy)
    private readonly occupancy: Repository<SeatOccupancy>,
    private readonly rabbit: AmqpConnection,
  ) {}

  /**
   * Создаёт бронь со статусом PENDING и публикует событие в RabbitMQ —
   * дальше её подхватывает Go-воркер ticket-worker.
   *
   * Бронь и занятость мест пишутся одной транзакцией; уникальный
   * констрейнт (movie_id, seat) не пускает двух клиентов на одно место:
   * проигравший в гонке получает 409 со списком занятых мест.
   */
  async create(dto: CreateBookingDto): Promise<BookingDto> {
    const seats = normalizeSeats(dto.seats);

    let booking: Booking;
    let movie: Movie;
    try {
      const result = await this.dataSource.transaction(async (em) => {
        const found = await em.findOneByOrFail(Movie, { id: dto.movieId });
        const toSave = em.create(Booking, {
          id: randomUUID(), // нужен до сохранения — на него ссылаются места
          movieId: found.id,
          movie: found,
          customerName: dto.customerName.trim(),
          seats,
          totalRub: computeTotal(found.priceRub, seats),
          status: 'PENDING',
        });

        try {
          await em.insert(
            SeatOccupancy,
            seats.map((seat) => ({
              movieId: found.id,
              seat,
              bookingId: toSave.id,
            })),
          );
        } catch (err) {
          if (isUniqueViolation(err)) throw new SeatsTakenError();
          throw err;
        }

        return { booking: await em.save(Booking, toSave), movie: found };
      });
      booking = result.booking;
      movie = result.movie;
    } catch (err) {
      if (err instanceof SeatsTakenError) {
        // транзакция откатилась — спрашиваем у БД, какие именно места заняты
        const rows = await this.occupancy.find({
          where: { movieId: dto.movieId, seat: In(seats) },
        });
        const seatsTaken = rows.map((r) => r.seat).sort(compareSeats);
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `Места уже заняты: ${seatsTaken.join(', ')}`,
          seatsTaken,
        });
      }
      throw err;
    }

    const event: BookingCreatedEvent = {
      bookingId: booking.id,
      movieId: movie.id,
      movieTitle: movie.title,
      customerName: booking.customerName,
      seats: booking.seats,
      totalRub: booking.totalRub,
      createdAt: booking.createdAt.toISOString(),
    };
    this.rabbit.publish('cinema', 'booking.created', event);
    this.logger.log(
      `Бронь ${booking.id} (${movie.title}, места ${booking.seats.join(', ')}) → в очередь`,
    );

    return toBookingDto(booking, movie);
  }

  async list(limit = 30): Promise<BookingDto[]> {
    const rows = await this.bookings.find({
      order: { createdAt: 'DESC' },
      take: limit,
      relations: { movie: true },
    });
    return rows.map((row) => toBookingDto(row));
  }

  /**
   * Компенсирующая сага: просим Go-воркер вернуть платёж.
   * Бронь уходит в CANCELLING условным UPDATE из CONFIRMED — двойной клик
   * по «Отменить» разрешается на стороне БД, проигравший получает 409.
   * Места держатся занятыми до вердикта воркера (booking.refunded).
   */
  async cancel(id: string): Promise<BookingDto> {
    const booking = await this.bookings.findOneByOrFail({ id });
    const movie = await this.movies.findOneByOrFail({ id: booking.movieId });

    const switched = await this.bookings.update(
      { id, status: 'CONFIRMED' },
      { status: 'CANCELLING' },
    );
    if (!switched.affected) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Отменить можно только подтверждённую бронь (сейчас: ${booking.status})`,
        status: booking.status,
      });
    }

    const event: BookingCancelledEvent = {
      bookingId: booking.id,
      movieId: booking.movieId,
      movieTitle: booking.movie.title,
      customerName: booking.customerName,
      seats: booking.seats,
      totalRub: booking.totalRub,
      cancelledAt: new Date().toISOString(),
    };
    this.rabbit.publish('cinema', 'booking.cancelled', event);
    this.logger.log(
      `Отмена брони ${booking.id} (${booking.movie.title}, возврат ${booking.totalRub} ₽) → в очередь`,
    );

    booking.status = 'CANCELLING';
    return toBookingDto(booking, movie);
  }

  async stats(): Promise<Record<BookingStatus, number>> {
    const rows = await this.bookings
      .createQueryBuilder('b')
      .select('b.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('b.status')
      .getRawMany<{ status: BookingStatus; count: string }>();

    const stats: Record<BookingStatus, number> = {
      PENDING: 0,
      CONFIRMED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    };
    for (const row of rows) {
      if (row.status in stats) stats[row.status] = Number(row.count);
    }
    return stats;
  }

  /** Карта занятости зала — источник данных для сетки мест на фронте */
  async seatMap(movieId: string): Promise<SeatMapDto> {
    await this.movies.findOneByOrFail({ id: movieId });
    const rows = await this.occupancy.find({
      where: { movieId },
      select: { seat: true },
    });
    const occupied = rows.map((r) => r.seat).sort(compareSeats);
    return {
      movieId,
      layout: { rows: HALL_ROWS, seatsPerRow: HALL_SEATS_PER_ROW },
      occupied,
      free: HALL_CAPACITY - occupied.length,
    };
  }

  /** Callback события booking.processed от Go-воркера */
  async handleProcessed(event: BookingProcessedEvent): Promise<void> {
    const booking = await this.bookings.findOneByOrFail({
      id: event.bookingId,
    });
    applyProcessed(booking, event);
    await this.bookings.save(booking);
    if (booking.status === 'FAILED') {
      // оплата не прошла — места возвращаются в продажу
      await this.occupancy.delete({ bookingId: booking.id });
    }
    this.logger.log(
      `Бронь ${event.bookingId} → ${event.status} (${event.processedBy})`,
    );
  }

  /** Callback события booking.refunded от Go-воркера */
  async handleRefunded(event: BookingRefundedEvent): Promise<void> {
    const booking = await this.bookings.findOneByOrFail({
      id: event.bookingId,
    });
    if (booking.status !== 'CANCELLING') {
      // ределивери или событие по уже закрытой саге — ничего не делаем
      this.logger.warn(
        `booking.refunded по бронь ${event.bookingId} в статусе ${booking.status} — пропуск`,
      );
      return;
    }
    const updated = applyRefunded(booking, event);
    await this.bookings.save(updated);
    if (updated.status === 'CANCELLED') {
      // возврат прошёл — места снова в продаже
      await this.occupancy.delete({ bookingId: booking.id });
    }
    this.logger.log(
      `Возврат ${event.bookingId} → ${event.status} (${event.processedBy})`,
    );
  }
}
