import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Movie } from '../movies/movie.entity';
import { BookingCreatedEvent, BookingProcessedEvent } from './booking-events';
import { Booking, BookingDto, BookingStatus, toBookingDto } from './booking.entity';
import { applyProcessed, computeTotal } from './booking.logic';
import { CreateBookingDto } from './dto/create-booking.dto';

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    @InjectRepository(Booking)
    private readonly bookings: Repository<Booking>,
    @InjectRepository(Movie)
    private readonly movies: Repository<Movie>,
    private readonly rabbit: AmqpConnection,
  ) {}

  /**
   * Создаёт бронь со статусом PENDING и публикует событие в RabbitMQ —
   * дальше её подхватывает Go-воркер ticket-worker.
   */
  async create(dto: CreateBookingDto): Promise<BookingDto> {
    const movie = await this.movies.findOneByOrFail({ id: dto.movieId });

    const booking = await this.bookings.save(
      this.bookings.create({
        movieId: movie.id,
        movie,
        customerName: dto.customerName.trim(),
        seats: dto.seats,
        totalRub: computeTotal(movie.priceRub, dto.seats),
        status: 'PENDING',
      }),
    );

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
      `Бронь ${booking.id} (${movie.title}, ${booking.seats} мест) → в очередь`,
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
    };
    for (const row of rows) {
      if (row.status in stats) stats[row.status] = Number(row.count);
    }
    return stats;
  }

  /** Callback события booking.processed от Go-воркера */
  async handleProcessed(event: BookingProcessedEvent): Promise<void> {
    const booking = await this.bookings.findOneByOrFail({
      id: event.bookingId,
    });
    applyProcessed(booking, event);
    await this.bookings.save(booking);
    this.logger.log(
      `Бронь ${event.bookingId} → ${event.status} (${event.processedBy})`,
    );
  }
}
