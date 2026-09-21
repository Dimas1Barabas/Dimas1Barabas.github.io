import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { HALL_CAPACITY } from '../bookings/hall';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { Session } from '../movies/session.entity';
import { positionOf, waitlistRefusalError } from './waitlist.logic';
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
   * из ответа, без cron). Позиция — среди WAITING сеанса; объём мал,
   * поэтому очередь каждого сеанса выгружается целиком.
   */
  async my(user: AuthUser): Promise<WaitlistMyEntryDto[]> {
    const mine = await this.entries.find({
      where: { userId: user.id },
      relations: ['session', 'session.movie'],
    });
    const upcoming = mine.filter(
      (e) => e.session && e.session.startsAt.getTime() > Date.now(),
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
}
