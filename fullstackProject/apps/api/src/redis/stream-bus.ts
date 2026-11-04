import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.tokens';

/**
 * Порт шины событий для кросс-подовой рассылки (канарейки/реплики api).
 *
 * Локальные слушатели всегда уведомляются синхронно самим стримом —
 * publish() доставляет событие ТОЛЬКО другим процессам. Так юнит-тесты
 * стримов остаются синхронными, а один под без соседей не ходит в Redis
 * за собственным эхом.
 */
export interface StreamBus {
  /** отправить событие другим подам (fire-and-forget: сбой — warn, не бросок) */
  publish(kind: string, payload: unknown): void;
  /** получить событие другого пода; один kind — один обработчик */
  subscribe(kind: string, handler: (payload: unknown) => void): void;
}

/** DI-токен шины (стримы зависят от порта, а не от ioredis-реализации) */
export const STREAM_BUS = 'STREAM_BUS';

/** конверт канала: автор (не слышать себя) + демультиплексор kind */
export interface BusEnvelope {
  pod: string;
  kind: string;
  payload: unknown;
}

/**
 * Redis pub/sub-реализация шины: один канал на процесс, kind в конверте.
 *
 * Подписчику — отдельное соединение (duplicate): соединение в режиме
 * SUBSCRIBE не может публиковать. ioredis сам переподписывается после
 * разрыва, publish идёт через общий клиент.
 *
 * Деградация: Redis недоступен → publish молча warn'ит (локальная
 * рассылка уже прошла), подписка ретраится фоном — стенд продолжает
 * работать как одиночный под, ровно как до этой шины.
 *
 *_payload_ уезжает JSON'ом: Date превращается в ISO-строку. Потребители
 * шин (SSE-контроллер и WS-гейтвей) дальше только сериализуют кадр или
 * перечитывают БД по id — строковые даты для них неотличимы.
 */
@Injectable()
export class RedisStreamBus implements StreamBus, OnModuleDestroy {
  private static readonly CHANNEL = 'cine.api.streams';

  private readonly logger = new Logger(RedisStreamBus.name);
  /** HOSTNAME в k8s = имя пода; случайный хвост страхует от коллизий */
  private readonly pod = `${process.env.HOSTNAME ?? 'local'}-${randomUUID().slice(0, 8)}`;
  private readonly handlers = new Map<string, (payload: unknown) => void>();
  private readonly subscriber: Redis;

  constructor(@Inject(REDIS_CLIENT) private readonly publisher: Redis) {
    this.subscriber = publisher.duplicate();
    this.subscriber.on('message', (_channel, raw) => this.dispatch(raw));
    // без обработчика 'error' ioredis ронял бы процесс необработанным событием
    this.subscriber.on('error', (err: Error) =>
      this.logger.warn(`шина: соединение подписки — ${err.message}`),
    );
    this.subscriber.subscribe(RedisStreamBus.CHANNEL).catch((err: Error) =>
      this.logger.warn(
        `шина: не подписались (${err.message}) — кросс-подовой рассылки нет`,
      ),
    );
  }

  publish(kind: string, payload: unknown): void {
    const envelope: BusEnvelope = { pod: this.pod, kind, payload };
    this.publisher
      .publish(RedisStreamBus.CHANNEL, JSON.stringify(envelope))
      .catch((err: Error) =>
        this.logger.warn(
          `шина: «${kind}» не ушёл другим подам (${err.message}) — локальные слушатели уже уведомлены`,
        ),
      );
  }

  subscribe(kind: string, handler: (payload: unknown) => void): void {
    this.handlers.set(kind, handler);
  }

  onModuleDestroy(): void {
    // disconnect, не quit: при shutdown не ждём сервер
    this.subscriber.disconnect();
  }

  private dispatch(raw: string): void {
    let envelope: BusEnvelope;
    try {
      envelope = JSON.parse(raw) as BusEnvelope;
    } catch {
      this.logger.warn('шина: мусорный кадр канала проигнорирован');
      return;
    }
    if (envelope.pod === this.pod) return; // своё пришло эхом — уже получили в emit
    this.handlers.get(envelope.kind)?.(envelope.payload);
  }
}
