import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { BONUS_SPEND_LIMIT } from '../bonus/bonus.logic';
import {
  BonusKind,
  BonusReason,
  BonusTransaction,
} from '../bonus/bonus-transaction.entity';
import { Movie } from '../movies/movie.entity';
import { Promo, PromoKind } from '../promos/promo.entity';
import {
  normalizePromoCode,
  promoDiscount,
  promoRefusalError,
} from '../promos/promo.logic';
import { Session } from '../movies/session.entity';
import {
  WaitlistReleaseReason,
  WaitlistSeatReleasedEvent,
} from '../waitlist/waitlist-events';
import { WaitlistEntry } from '../waitlist/waitlist.entity';
import { BookingStream } from './booking-stream';
import { SeatStream } from './seat-stream';
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
import {
  TicketDto,
  TicketVerifyResultDto,
  parseTicketQr,
  ticketCanonical,
  ticketSignatureMatches,
  toTicketDto,
} from './ticket.logic';

/**
 * Сигнал «место уже занято», проброшенный из транзакции наружу —
 * там он обогащается списком конфликтных мест и становится 409.
 */
class SeatsTakenError extends Error {
  constructor() {
    super('Места уже заняты');
  }
}

/**
 * Сигнал «активация промокода не прошла», проброшенный из транзакции
 * оплаты — там он обогащается причиной (не найден / истёк / исчерпан)
 * и превращается в 404/410/409. Транзакция при этом откатывается целиком:
 * бронь остаётся в PENDING_PAYMENT.
 */
class PromoRefusedError extends Error {
  constructor(readonly code: string) {
    super('Промокод не подошёл');
  }
}

/** причины отказа тратить бонусы при оплате */
type BonusRefusedReason =
  | 'bonusOverLimit'
  | 'bonusInsufficient'
  | 'bonusUnavailable';

/**
 * Сигнал «бонусы не подошли», проброшенный из транзакции оплаты:
 * лимит половины чека / не хватает баланса / гостевая бронь без счёта.
 * Наружу становится 409 с кодом причины; транзакция откатывается
 * целиком — бронь остаётся в PENDING_PAYMENT, промо-активация тоже.
 */
class BonusRefusedError extends Error {
  constructor(readonly reason: BonusRefusedReason) {
    super('Бонусы не подошли');
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
    @InjectRepository(Promo)
    private readonly promos: Repository<Promo>,
    // напрямую репозиторием: WaitlistModule импортирует BookingsModule,
    // обратной зависимости нет — так цикл модулей не возникает
    @InjectRepository(WaitlistEntry)
    private readonly waitlistEntries: Repository<WaitlistEntry>,
    private readonly rabbit: AmqpConnection,
    private readonly stream: BookingStream,
    private readonly seatStream: SeatStream,
  ) {}

  /**
   * Места снова в продаже — событие листу ожидания. Контекст фильма
   * не прикладываем: консьюмер сам перечитает сеанс из БД.
   * Ределивери (краш до ack) может уведомить следующего в очереди —
   * это безопасно: уведомление не резерв, гонка остаётся честной.
   */
  private publishSeatsReleased(
    booking: Booking,
    reason: WaitlistReleaseReason,
  ): void {
    const event: WaitlistSeatReleasedEvent = {
      sessionId: booking.sessionId,
      bookingId: booking.id,
      seats: booking.seats,
      reason,
      releasedAt: new Date().toISOString(),
    };
    this.rabbit.publish('cinema', 'waitlist.seat.released', event);
    // живая карта мест: все четыре освобождения закрываются здесь одним
    // сигналом (вызывается уже после occupancy.delete — гейтвей перечитает
    // пост-состояние)
    this.seatStream.emit({ sessionId: booking.sessionId });
  }

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
    // транзакция закоммитилась — места заняты: сигнал живой карте
    // (внутри замыкания транзакции нельзя: гейтвей раздал бы докоммитное)
    this.seatStream.emit({ sessionId: booking.sessionId });
    this.rabbit.publish('cinema', 'booking.payment.wait', waitEvent);
    this.logger.log(
      `Бронь ${booking.id} (${movie.title}, ${session.hall} ${session.startsAt.toISOString()}, места ${booking.seats.join(', ')}) ждёт оплаты до ${waitEvent.expiresAt}`,
    );
    await this.push(booking, movie, session);

    // забронировал — запись в листе ожидания этого сеанса больше не нужна
    // (безусловный LEFT: идемпотентно при повторной брони того же юзера)
    await this.waitlistEntries.update(
      { sessionId: dto.sessionId, userId: user.id },
      { status: 'LEFT' },
    );

    return toBookingDto(booking, movie, session);
  }

  /**
   * Оплата брони: PENDING_PAYMENT → PENDING условным UPDATE — гонку с
   * таймаутом резерва и двойным кликом разрешает БД, проигравший получает
   * 409 с текущим статусом. С промокодом переключение и списание активации
   * — одна транзакция: инкремент used_count атомарен
   * (WHERE used_count < max_activations AND expires_at > now), поэтому
   * гонку за последний код решает БД; проигравшему транзакция откатывает и
   * переключение брони — она остаётся в PENDING_PAYMENT. Бонусы — тем же
   * способом сразу после промокода: не больше половины чека (со скидкой) и
   * не больше баланса; контрольный пересчёт SUM после вставки не даёт
   * параллельным оплатам увести счёт в минус. Воркеру уходит событие с уже
   * финальной суммой: вердикт, возврат и аналитика видят одно число.
   */
  async pay(
    id: string,
    user: AuthUser,
    promoCode?: string,
    useBonuses?: number,
  ): Promise<BookingDto> {
    const booking = await this.bookings.findOneByOrFail({ id });
    if (booking.userId && booking.userId !== user.id) {
      throw new ForbiddenException('Это не ваша бронь');
    }
    const { movie, session } = await this.contextOf(booking);
    const code = promoCode ? normalizePromoCode(promoCode) : null;

    let applied: { code: string; discountRub: number } | null = null;
    let spent = 0;
    try {
      const result = await this.dataSource.transaction(async (em) => {
        const switched = await em.update(
          Booking,
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

        let applied: { code: string; discountRub: number } | null = null;
        if (code) {
          // атомарная активация: инкремент только при запасе и живом сроке.
          // postgres-драйвер TypeORM для UPDATE возвращает кортеж
          // [строки RETURNING, число затронутых] — см. PostgresQueryRunner
          const [activated, activations] = await em.query<
            [{ code: string; kind: PromoKind; value: number }[], number]
          >(
            `UPDATE promos SET used_count = used_count + 1
               WHERE code = $1 AND used_count < max_activations
                 AND expires_at > now()
             RETURNING code, kind, value`,
            [code],
          );
          if (!activations) throw new PromoRefusedError(code);

          const discountRub = promoDiscount(
            booking.totalRub,
            activated[0].kind,
            activated[0].value,
          );
          await em.update(
            Booking,
            { id },
            {
              totalRub: booking.totalRub - discountRub,
              promoCode: activated[0].code,
              discountRub,
            },
          );
          applied = { code: activated[0].code, discountRub };
        }

        // бонусы — после промокода: лимит «половина чека» считается от
        // суммы уже со скидкой; списание живёт в той же транзакции, что
        // переключение статуса и промо-активация
        const base = booking.totalRub - (applied?.discountRub ?? 0);
        let spent = 0;
        if (useBonuses) {
          if (!booking.userId) throw new BonusRefusedError('bonusUnavailable');
          if (useBonuses > Math.floor(base * BONUS_SPEND_LIMIT)) {
            throw new BonusRefusedError('bonusOverLimit');
          }
          if (useBonuses > (await this.bonusBalance(em, booking.userId))) {
            throw new BonusRefusedError('bonusInsufficient');
          }
          await this.insertBonus(em, {
            userId: booking.userId,
            bookingId: id,
            kind: 'spend',
            reason: 'payment',
            amount: useBonuses,
          });
          // ledger как деньги: контрольный пересчёт после вставки не
          // должен уйти в минус — гонку двух параллельных оплат одним
          // балансом решает эта проверка (проигравший откатывается целиком)
          if ((await this.bonusBalance(em, booking.userId)) < 0) {
            throw new BonusRefusedError('bonusInsufficient');
          }
          await em.update(
            Booking,
            { id },
            { totalRub: base - useBonuses, bonusSpent: useBonuses },
          );
          spent = useBonuses;
        }
        return { applied, spent };
      });
      applied = result.applied;
      spent = result.spent;
    } catch (err) {
      if (err instanceof PromoRefusedError) {
        // транзакция откатилась — спрашиваем у БД причину отказа
        const promo = await this.promos.findOneBy({ code: err.code });
        throw promoRefusalError(promo);
      }
      if (err instanceof BonusRefusedError) {
        throw await this.bonusRefusalError(err.reason, booking);
      }
      throw err;
    }

    booking.status = 'PENDING';
    if (applied) {
      booking.promoCode = applied.code;
      booking.discountRub = applied.discountRub;
    }
    if (spent > 0) booking.bonusSpent = spent;
    booking.totalRub -= (applied?.discountRub ?? 0) + spent;
    this.rabbit.publish(
      'cinema',
      'booking.created',
      this.createdEventOf(booking, movie, session),
    );
    this.logger.log(
      `Оплата брони ${booking.id} (${booking.totalRub} ₽${applied ? `, промокод ${applied.code} −${applied.discountRub} ₽` : ''}${spent ? `, бонусы −${spent}` : ''}) → в очередь`,
    );
    await this.push(booking, movie, session);
    return toBookingDto(booking, movie, session);
  }

  /** баланс бонусного счёта: SUM(accrual) − SUM(spend) от источника-ledger */
  private async bonusBalance(
    em: EntityManager,
    userId: string,
  ): Promise<number> {
    const rows = await em.query<{ balance: string | null }[]>(
      `SELECT COALESCE(SUM(CASE kind WHEN 'accrual' THEN amount ELSE -amount END), 0) AS balance
         FROM bonus_transactions WHERE user_id = $1`,
      [userId],
    );
    // SUM(int) в Postgres → bigint, pg-драйвер отдаёт строкой
    return Number(rows[0]?.balance ?? 0);
  }

  /** запись в ledger; uq(booking_id, reason) + orIgnore гасят дубль ределивери */
  private insertBonus(
    em: EntityManager,
    row: {
      userId: string;
      bookingId: string;
      kind: BonusKind;
      reason: BonusReason;
      amount: number;
    },
  ) {
    return em
      .createQueryBuilder()
      .insert()
      .into(BonusTransaction)
      .values(row)
      .orIgnore()
      .execute();
  }

  /** причина отказа бонусов → 409 с кодом; баланс перечитан для сообщения */
  private async bonusRefusalError(
    reason: BonusRefusedReason,
    booking: Booking,
  ): Promise<ConflictException> {
    if (reason === 'bonusUnavailable') {
      return new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Гостевые брони нельзя оплатить бонусами',
        code: 'bonusUnavailable',
      });
    }
    if (reason === 'bonusOverLimit') {
      return new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Бонусами можно закрыть не больше половины чека',
        code: 'bonusOverLimit',
      });
    }
    const balance = booking.userId
      ? await this.bonusBalance(this.dataSource.manager, booking.userId)
      : 0;
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: `Не хватает бонусов: на счету ${balance}`,
      code: 'bonusInsufficient',
    });
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
   * Билеты CONFIRMED-брони: по одному на место, с HMAC-подписью для QR.
   * Билет — производная брони: подпись детерминирована (бронь + место +
   * сеанс), ничего не хранится. Отмена гасит билеты сама (статус уходит
   * из CONFIRMED → 409 bookingNotConfirmed), неудавшийся возврат
   * (REFUND_FAILED → снова CONFIRMED) оживляет их без нашего участия.
   */
  async tickets(id: string, user: AuthUser): Promise<TicketDto[]> {
    const booking = await this.bookings.findOneByOrFail({ id });
    if (booking.userId && booking.userId !== user.id) {
      throw new ForbiddenException('Это не ваша бронь');
    }
    if (booking.status !== 'CONFIRMED') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Билеты выдаются только по подтверждённой брони (сейчас: ${booking.status})`,
        code: 'bookingNotConfirmed',
        status: booking.status,
      });
    }
    const { movie, session } = await this.contextOf(booking);
    return booking.seats.map((seat) =>
      toTicketDto(booking, movie, session, seat),
    );
  }

  /**
   * Сканер на входе в зал: проверяет QR-строку билета против БД.
   * Подпись отсеивает подделку (badSignature), статус брони — отменённые
   * и незавершённые (bookingNotConfirmed), состав мест — чужое место
   * (seatMismatch), время сеанса — просроченные (sessionPassed).
   * Отказ — не ошибка, а вердикт с причиной: контролёру нужен экран, а не 4xx.
   */
  async verifyTicket(payload: string): Promise<TicketVerifyResultDto> {
    const parsed = parseTicketQr(payload);
    if (!parsed) {
      return { valid: false, reason: 'malformedPayload', bookingId: null, seat: null, movieTitle: null, sessionAt: null, hall: null, customerName: null };
    }
    const scanned = { bookingId: parsed.bookingId, seat: parsed.seat };
    if (!ticketSignatureMatches(parsed.canonical, parsed.signature)) {
      return { valid: false, reason: 'badSignature', ...scanned, movieTitle: null, sessionAt: null, hall: null, customerName: null };
    }
    const booking = await this.bookings.findOneBy({ id: parsed.bookingId });
    if (!booking) {
      return { valid: false, reason: 'bookingNotFound', ...scanned, movieTitle: null, sessionAt: null, hall: null, customerName: null };
    }
    if (booking.status !== 'CONFIRMED') {
      return { valid: false, reason: 'bookingNotConfirmed', ...scanned, movieTitle: null, sessionAt: null, hall: null, customerName: null };
    }
    if (!booking.seats.includes(parsed.seat)) {
      return { valid: false, reason: 'seatMismatch', ...scanned, movieTitle: null, sessionAt: null, hall: null, customerName: null };
    }
    const { movie, session } = await this.contextOf(booking);
    const context = {
      ...scanned,
      movieTitle: movie.title,
      sessionAt: session.startsAt.toISOString(),
      hall: session.hall,
    };
    if (session.startsAt.getTime() < Date.now()) {
      return { valid: false, reason: 'sessionPassed', ...context, customerName: null };
    }
    return { valid: true, reason: null, ...context, customerName: booking.customerName };
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
    this.publishSeatsReleased(booking, 'CANCELLED_UNPAID');
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
      this.publishSeatsReleased(booking, 'FAILED');
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
    this.publishSeatsReleased(booking, 'EXPIRED');
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
      this.publishSeatsReleased(updated, 'REFUNDED');
    }
    this.logger.log(
      `Возврат ${event.bookingId} → ${event.status} (${event.processedBy})`,
    );
    const { movie, session } = await this.contextOf(updated);
    await this.push(updated, movie, session);
  }
}
