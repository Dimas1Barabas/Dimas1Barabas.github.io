import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { BookingStream } from '../bookings/booking-stream';
import { HALL_CAPACITY } from '../bookings/hall';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { User } from '../users/user.entity';
import { pickNextToNotify, positionOf, webLinkBase, waitlistRefusalError } from './waitlist.logic';
import {
  UserWaitlistSeatEvent,
  WaitlistSeatReleasedEvent,
  WaitlistStreamPayload,
} from './waitlist-events';
import {
  WaitlistEntry,
  WaitlistEntryDto,
  WaitlistMyEntryDto,
  toWaitlistEntryDto,
  toWaitlistMyDto,
} from './waitlist.entity';

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
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    @InjectRepository(WaitlistEntry)
    private readonly entries: Repository<WaitlistEntry>,
    @InjectRepository(Session)
    private readonly sessions: Repository<Session>,
    @InjectRepository(SeatOccupancy)
    private readonly occupancy: Repository<SeatOccupancy>,
    @InjectRepository(Movie)
    private readonly movies: Repository<Movie>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly rabbit: AmqpConnection,
    private readonly stream: BookingStream,
  ) {}

  /**
   * Встать в лист ожидания. Гварды: сеанс будущий и зал полный — иначе
   * очередь не нужна. Дубль решает uq_waitlist_session_user: гонке двух
   * join нечего мериться, проигравший получает 409 waitlistAlready.
   * Повторный вход после NOTIFIED/LEFT обновляет queued_at — запись
   * встаёт в конец очереди (честная гонка: уведомление уже было).
   */
  async join(sessionId: string, user: AuthUser): Promise<WaitlistEntryDto> {
    const session = await this.sessions.findOneByOrFail({ id: sessionId });
    if (session.startsAt.getTime() <= Date.now()) {
      throw waitlistRefusalError('sessionPassed');
    }

    const occupied = await this.occupancy.count({ where: { sessionId } });
    if (occupied < HALL_CAPACITY) {
      throw waitlistRefusalError('sessionNotFull');
    }

    const existing = await this.entries.findOneBy({
      sessionId,
      userId: user.id,
    });
    if (existing?.status === 'WAITING') {
      throw waitlistRefusalError('waitlistAlready');
    }

    const now = new Date();
    // as const: спред расширяет статус до string, а save() типизирован по литералам
    const entry: WaitlistEntry = existing
      ? { ...existing, status: 'WAITING' as const, queuedAt: now, notifiedAt: null }
      : this.entries.create({
          sessionId,
          userId: user.id,
          status: 'WAITING',
          queuedAt: now,
          notifiedAt: null,
        });

    try {
      const saved = await this.entries.save(entry);
      const rows = await this.entries.find({ where: { sessionId } });
      const position = positionOf(rows, saved.id);
      this.logger.log(
        `Пользователь ${user.id} в листе ожидания сеанса ${sessionId} (позиция ${position})`,
      );
      return toWaitlistEntryDto(saved, position);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // два join впритык: uq-констрейнт — последний арбитр
        throw waitlistRefusalError('waitlistAlready');
      }
      throw err;
    }
  }

  /**
   * Выйти из очереди. Двухшагово (прочитать → условный UPDATE по id):
   * повторный leave застенёт LEFT и получит 404 waitlistEntryNotFound —
   * для клиента это то же «записи уже нет».
   */
  async leave(sessionId: string, user: AuthUser): Promise<void> {
    const existing = await this.entries.findOneBy({
      sessionId,
      userId: user.id,
    });
    if (!existing || existing.status === 'LEFT') {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'Запись в листе ожидания не найдена',
        code: 'waitlistEntryNotFound',
      });
    }
    await this.entries.update({ id: existing.id }, { status: 'LEFT' });
    this.logger.log(
      `Пользователь ${user.id} покинул лист ожидания сеанса ${sessionId}`,
    );
  }

  /**
   * Мои записи — только по будущим сеансам (прошедшие лениво гасим
   * из ответа, без cron) и только активные: LEFT — история, её клиенту
   * не показываем. Позиция — среди WAITING сеанса; объём мал, поэтому
   * очередь каждого сеанса выгружается целиком.
   */
  async my(user: AuthUser): Promise<WaitlistMyEntryDto[]> {
    const mine = await this.entries.find({
      where: { userId: user.id },
      relations: ['session', 'session.movie'],
    });
    const upcoming = mine.filter(
      (e) =>
        e.session &&
        e.session.startsAt.getTime() > Date.now() &&
        e.status !== 'LEFT',
    );

    const queues = new Map<string, WaitlistEntry[]>();
    for (const sid of [...new Set(upcoming.map((e) => e.sessionId))]) {
      queues.set(sid, await this.entries.find({ where: { sessionId: sid } }));
    }

    return upcoming
      .sort(
        (a, b) => a.session.startsAt.getTime() - b.session.startsAt.getTime(),
      )
      .map((e) =>
        toWaitlistMyDto(e, positionOf(queues.get(e.sessionId) ?? [], e.id)),
      );
  }

  /**
   * Callback события waitlist.seat.released: места вернулись в продажу —
   * сообщаем голове очереди. Честная гонка: место НЕ резервируется,
   * уведомление — только «успей проверить». Условный UPDATE в NOTIFIED
   * закрывает гонку двух событий по одной голове (affected = 0 → пропуск).
   * Ределивери после краша уведомит следующего — безопасно: уведомление
   * не резерв, лишний претендент в честной гонке хуже не делает.
   */
  async handleSeatReleased(event: WaitlistSeatReleasedEvent): Promise<void> {
    const rows = await this.entries.find({ where: { sessionId: event.sessionId } });
    const head = pickNextToNotify(rows);
    if (!head) {
      this.logger.log(
        `Места освободились на сеансе ${event.sessionId} (${event.reason}), но очередь пуста`,
      );
      return;
    }

    const notifiedAt = new Date();
    const switched = await this.entries.update(
      { id: head.id, status: 'WAITING' },
      { status: 'NOTIFIED', notifiedAt },
    );
    if (!switched.affected) {
      this.logger.warn(
        `Голова очереди ${head.id} уже не WAITING — уведомление пропущено`,
      );
      return;
    }

    const session = await this.sessions.findOneByOrFail({ id: event.sessionId });
    const movie = await this.movies.findOneByOrFail({ id: session.movieId });
    const user = await this.users.findOneByOrFail({ id: head.userId });

    // письмо через notification-service — 5-й поток, по образцу user.password.reset
    const letter: UserWaitlistSeatEvent = {
      email: user.email,
      userId: user.id,
      sessionId: session.id,
      movieId: movie.id,
      movieTitle: movie.title,
      hall: session.hall,
      sessionAt: session.startsAt.toISOString(),
      message:
        `Место освободилось на сеансе «${movie.title}» ` +
        `(${session.hall}, ${session.startsAt.toLocaleString('ru-RU')}) — ` +
        `успей забронировать: ${webLinkBase()}?movie=${movie.id}`,
    };
    this.rabbit.publish('cinema', 'user.waitlist.seat', letter);

    // in-app: тот же SSE-эндпоинт, клиент матчит payload.userId по себе
    const payload: WaitlistStreamPayload = {
      userId: user.id,
      sessionId: session.id,
      movieId: movie.id,
      movieTitle: movie.title,
      hall: session.hall,
      sessionAt: session.startsAt.toISOString(),
      seats: event.seats,
      notifiedAt: notifiedAt.toISOString(),
    };
    this.stream.emitWaitlist(payload);

    this.logger.log(
      `Место освободилось (${event.reason}) → уведомлена голова очереди ${head.id} сеанса ${event.sessionId}`,
    );
  }
}
