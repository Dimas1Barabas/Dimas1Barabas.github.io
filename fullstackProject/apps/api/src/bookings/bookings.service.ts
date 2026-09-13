import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { BookingStream } from './booking-stream';
import {
  BookingCancelledEvent,
  BookingCreatedEvent,
  BookingExpiredEvent,
  BookingPaymentWaitEvent,
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
import { paymentTimeoutMs } from './payment-timeout';
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
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,
    @InjectRepository(SeatOccupancy)
    private readonly occupancy: Repository<SeatOccupancy>,
    private readonly rabbit: AmqpConnection,
    private readonly stream: BookingStream,
  ) {}

  /** толкает изменение брони подключённым SSE-клиентам */
  private async push(
    booking: Booking,
    movie: Movie,
    session: Session,
  ): Promise<void> {
    this.stream.emit({
      booking: toBookingDto(booking, movie, session),
      stats: await this.stats(),
    });
  }

  /** фильм и сеанс брони — findOneByOrFail не грузит relations */
  private async contextOf(
    booking: Booking,
  ): Promise<{ movie: Movie; session: Session }> {
    const [movie, session] = await Promise.all([
      this.movies.findOneByOrFail({ id: booking.movieId }),
      this.sessions.findOneByOrFail({ id: booking.sessionId }),
    ]);
    return { movie, session };
  }

  /** событие «готова к проведению оплаты» — публикуется при pay() */
  private createdEventOf(
    booking: Booking,
    movie: Movie,
    session: Session,
  ): BookingCreatedEvent {
    return {
      bookingId: booking.id,
      movieId: movie.id,
      movieTitle: movie.title,
      sessionId: session.id,
      sessionAt: session.startsAt.toISOString(),
      hall: session.hall,
      customerName: booking.customerName,
      seats: booking.seats,
      totalRub: booking.totalRub,
      createdAt: booking.createdAt.toISOString(),
    };
  }

  /**
   * Создаёт бронь со статусом PENDING_PAYMENT и запускает таймер резерва:
   * событие уходит в wait-очередь RabbitMQ, которая без потребителей держит
   * его ровно окно оплаты и по TTL (dead-letter) отдаёт в
   * «booking.payment.timeout» — оттуда её подхватывает Go-воркер.
   *
   * Владелец и имя покупателя — из JWT: customerName в теле опционален.
   * Фильм выводится из сеанса — истина о привязке хранится в одном месте.
   * Бронь и занятость мест пишутся одной транзакцией; уникальный
   * констрейнт (session_id, seat) не пускает двух клиентов на одно место:
   * проигравший в гонке получает 409 со списком занятых мест.
   */
  async create(dto: CreateBookingDto, user: AuthUser): Promise<BookingDto> {
    const seats = normalizeSeats(dto.seats);
    const customerName = (dto.customerName ?? user.name).trim();

    let booking: Booking;
    let movie: Movie;
    let session: Session;
    try {
      const result = await this.dataSource.transaction(async (em) => {
        const foundSession = await em.findOneByOrFail(Session, {
          id: dto.sessionId,
        });
        const found = await em.findOneByOrFail(Movie, {
          id: foundSession.movieId,
        });
        const toSave = em.create(Booking, {
          id: randomUUID(), // нужен до сохранения — на него ссылаются места
          movieId: found.id,
          movie: found,
          sessionId: foundSession.id,
          session: foundSession,
          customerName,
          userId: user.id,
          seats,
          totalRub: computeTotal(found.priceRub, seats),
          status: 'PENDING_PAYMENT',
          expiresAt: new Date(Date.now() + paymentTimeoutMs()),
        });

        try {
          await em.insert(
            SeatOccupancy,
            seats.map((seat) => ({
              sessionId: foundSession.id,
              seat,
              bookingId: toSave.id,
            })),
          );
        } catch (err) {
          if (isUniqueViolation(err)) throw new SeatsTakenError();
          throw err;
        }

        return {
          booking: await em.save(Booking, toSave),
          movie: found,
          session: foundSession,
        };
      });
      booking = result.booking;
      movie = result.movie;
      session = result.session;
    } catch (err) {
      if (err instanceof SeatsTakenError) {
        // транзакция откатилась — спрашиваем у БД, какие именно места заняты
        const rows = await this.occupancy.find({
          where: { sessionId: dto.sessionId, seat: In(seats) },
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

    const waitEvent: BookingPaymentWaitEvent = {
      bookingId: booking.id,
      totalRub: booking.totalRub,
      expiresAt: booking.expiresAt!.toISOString(),
    };
    this.rabbit.publish('cinema', 'booking.payment.wait', waitEvent);
    this.logger.log(
      `Бронь ${booking.id} (${movie.title}, ${session.hall} ${session.startsAt.toISOString()}, места ${booking.seats.join(', ')}) ждёт оплаты до ${waitEvent.expiresAt}`,
    );
    await this.push(booking, movie, session);

    return toBookingDto(booking, movie, session);
  }

  /**
   * Оплата брони: PENDING_PAYMENT → PENDING условным UPDATE — гонку с
   * таймаутом резерва и двойным кликом разрешает БД, проигравший получает
   * 409 с текущим статусом. После переключения публикуется существующее
   * событие booking.created: Go-воркер «проводит платёж» и отвечает
   * вердиктом booking.processed (CONFIRMED | FAILED).
   */
  async pay(id: string, user: AuthUser): Promise<BookingDto> {
    const booking = await this.bookings.findOneByOrFail({ id });
    if (booking.userId && booking.userId !== user.id) {
      throw new ForbiddenException('Это не ваша бронь');
    }
    const { movie, session } = await this.contextOf(booking);

    const switched = await this.bookings.update(
      { id, status: 'PENDING_PAYMENT' },
      { status: 'PENDING' },
    );
    if (!switched.affected) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Оплатить можно только бронь, ждущую оплаты (сейчас: ${booking.status})`,
        status: booking.status,
      });
    }

    booking.status = 'PENDING';
    this.rabbit.publish(
      'cinema',
      'booking.created',
      this.createdEventOf(booking, movie, session),
    );
    this.logger.log(`Оплата брони ${booking.id} (${booking.totalRub} ₽) → в очередь`);
    await this.push(booking, movie, session);
    return toBookingDto(booking, movie, session);
  }

  async list(limit = 30): Promise<BookingDto[]> {
    const rows = await this.bookings.find({
      order: { createdAt: 'DESC' },
      take: limit,
      relations: { movie: true, session: true },
    });
    return rows.map((row) => toBookingDto(row));
  }

  /** личный кабинет: брони владельца из JWT, свежие сверху */
  async my(user: AuthUser, limit = 100): Promise<BookingDto[]> {
    const rows = await this.bookings.find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
      take: limit,
      relations: { movie: true, session: true },
    });
    return rows.map((row) => toBookingDto(row));
  }

  /**
   * Неоплаченная бронь: возвращать нечего — закрываем сразу и без воркера,
   * места освобождаются тут же. Условный UPDATE из PENDING_PAYMENT решает
   * гонку с оплатой и таймаутом резерва (проигравший получает 409/пропуск).
   */
  private async cancelUnpaid(
    booking: Booking,
    movie: Movie,
    session: Session,
  ): Promise<BookingDto | null> {
    const message = 'Бронь отменена до оплаты — места снова в продаже';
    const switched = await this.bookings.update(
      { id: booking.id, status: 'PENDING_PAYMENT' },
      { status: 'CANCELLED', message },
    );
    if (!switched.affected) return null;

    await this.occupancy.delete({ bookingId: booking.id });
    this.logger.log(`Отмена неоплаченной брони ${booking.id} (${movie.title})`);
    booking.status = 'CANCELLED';
    booking.message = message;
    await this.push(booking, movie, session);
    return toBookingDto(booking, movie, session);
  }

  /**
   * Отмена брони. Неоплаченная (PENDING_PAYMENT) закрывается сразу —
   * локально, без воркера. Подтверждённая (CONFIRMED) запускает
   * компенсирующую сагу: просим Go-воркера вернуть платёж, бронь уходит
   * в CANCELLING условным UPDATE — двойной клик по «Отменить» разрешается
   * на стороне БД, проигравший получает 409. Места держатся занятыми
   * до вердикта воркера (booking.refunded).
   */
  async cancel(id: string, user: AuthUser): Promise<BookingDto> {
    const booking = await this.bookings.findOneByOrFail({ id });
    // чужую бронь отменять нельзя (null — досимвольные брони без владельца)
    if (booking.userId && booking.userId !== user.id) {
      throw new ForbiddenException('Это не ваша бронь');
    }
    // грузим явно: findOneByOrFail не подтягивает relations, а событию
    // нужны title/hall (в юнит-тестах это маскировали Map-фейки)
    const { movie, session } = await this.contextOf(booking);

    const unpaid = await this.cancelUnpaid(booking, movie, session);
    if (unpaid) return unpaid;

    const switched = await this.bookings.update(
      { id, status: 'CONFIRMED' },
      { status: 'CANCELLING' },
    );
    if (!switched.affected) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Отменить можно только неоплаченную или подтверждённую бронь (сейчас: ${booking.status})`,
        status: booking.status,
      });
    }

    const event: BookingCancelledEvent = {
      bookingId: booking.id,
      movieId: booking.movieId,
      movieTitle: movie.title,
      sessionId: session.id,
      sessionAt: session.startsAt.toISOString(),
      hall: session.hall,
      customerName: booking.customerName,
      seats: booking.seats,
      totalRub: booking.totalRub,
      cancelledAt: new Date().toISOString(),
    };
    this.rabbit.publish('cinema', 'booking.cancelled', event);
    this.logger.log(
      `Отмена брони ${booking.id} (${movie.title}, возврат ${booking.totalRub} ₽) → в очередь`,
    );

    booking.status = 'CANCELLING';
    await this.push(booking, movie, session);
    return toBookingDto(booking, movie, session);
  }

  async stats(): Promise<Record<BookingStatus, number>> {
    const rows = await this.bookings
      .createQueryBuilder('b')
      .select('b.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('b.status')
      .getRawMany<{ status: BookingStatus; count: string }>();

    const stats: Record<BookingStatus, number> = {
      PENDING_PAYMENT: 0,
      PENDING: 0,
      CONFIRMED: 0,
      FAILED: 0,
      EXPIRED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    };
    for (const row of rows) {
      if (row.status in stats) stats[row.status] = Number(row.count);
    }
    return stats;
  }

  /** Карта занятости зала сеанса — источник данных для сетки мест на фронте */
  async seatMap(sessionId: string): Promise<SeatMapDto> {
    await this.sessions.findOneByOrFail({ id: sessionId });
    const rows = await this.occupancy.find({
      where: { sessionId },
      select: { seat: true },
    });
    const occupied = rows.map((r) => r.seat).sort(compareSeats);
    return {
      sessionId,
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
    if (booking.status !== 'PENDING') {
      // ределивери или «хвост» старой топологии: бронь уже закрыта иначе
      // (EXPIRED/CANCELLED) — вердикт по ней не должен оживлять места
      this.logger.warn(
        `booking.processed по бронь ${event.bookingId} в статусе ${booking.status} — пропуск`,
      );
      return;
    }
    applyProcessed(booking, event);
    await this.bookings.save(booking);
    if (event.status === 'FAILED') {
      // оплата не прошла — места возвращаются в продажу
      await this.occupancy.delete({ bookingId: booking.id });
    }
    this.logger.log(
      `Бронь ${event.bookingId} → ${event.status} (${event.processedBy})`,
    );
    const { movie, session } = await this.contextOf(booking);
    await this.push(booking, movie, session);
  }

  /**
   * Callback события booking.expired от Go-воркера: TTL wait-очереди истёк.
   * Условный UPDATE из PENDING_PAYMENT — если клиент успел заплатить или
   * отменил бронь, affected = 0 и событие молча пропускается
   * (идемпотентность гонки pay/cancel-vs-timeout).
   */
  async handleExpired(event: BookingExpiredEvent): Promise<void> {
    const updated = await this.bookings.update(
      { id: event.bookingId, status: 'PENDING_PAYMENT' },
      {
        status: 'EXPIRED',
        message: event.message,
        processedBy: event.processedBy,
        processedAt: new Date(event.expiredAt),
      },
    );
    if (!updated.affected) {
      this.logger.warn(
        `booking.expired по бронь ${event.bookingId} уже не в PENDING_PAYMENT — пропуск`,
      );
      return;
    }
    // резерв истёк — места снова в продаже
    await this.occupancy.delete({ bookingId: event.bookingId });
    this.logger.log(`Бронь ${event.bookingId} → EXPIRED (${event.processedBy})`);
    const booking = await this.bookings.findOneByOrFail({ id: event.bookingId });
    const { movie, session } = await this.contextOf(booking);
    await this.push(booking, movie, session);
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
    const { movie, session } = await this.contextOf(updated);
    await this.push(updated, movie, session);
  }
}
