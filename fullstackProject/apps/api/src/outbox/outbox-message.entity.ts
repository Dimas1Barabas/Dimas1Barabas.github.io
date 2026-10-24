import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Запись транзакционного outbox: «опубликовать событие routingKey с payload».
 * Пишется EntityManager'ом бизнес-транзакции (OutboxService.enqueue), поэтому
 * событие переживает крах между COMMIT и publish — релей (services/outbox-relay)
 * заберёт его позже и поставит publishedAt. Дропов нет: сбой публикации —
 * attempts+1 и nextAttemptAt с бэкоффом.
 */
@Entity('outbox_messages')
@Index('idx_outbox_pending', ['nextAttemptAt'], { where: 'published_at IS NULL' })
export class OutboxMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** routing key в exchange `cinema` */
  @Column({ name: 'routing_key', length: 100 })
  routingKey: string;

  /** JSON-тело события — то, что раньше уходило в publish напрямую */
  @Column({ type: 'jsonb' })
  payload: object;

  /** amqp-заголовки на момент записи: traceparent — трейс исходной операции */
  @Column({ type: 'jsonb', default: {} })
  headers: Record<string, string>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /** ставит релей после успешного publish; NULL — ждёт доставки */
  @Column({ name: 'published_at', type: 'timestamp', nullable: true })
  publishedAt: Date | null;

  /** сколько публикаций не удалось; двигает nextAttemptAt с бэкоффом */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** раньше релей не берёт (пауза после ошибки) */
  @Column({ name: 'next_attempt_at', type: 'timestamp', default: () => 'now()' })
  nextAttemptAt: Date;

  /** последняя ошибка publish — диагностика застрявших сообщений */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;
}
