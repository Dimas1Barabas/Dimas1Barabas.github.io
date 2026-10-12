import { Injectable, Logger } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

import { tracePublishOptions } from '../tracing/rabbit-trace';
import {
  ANALYTICS_EVENT_RK,
  AnalyticsEventMessage,
} from './analytics-events';
import { IngestAnalyticsDto } from './dto/ingest.dto';

/**
 * Тонкий инжест аналитики: принимает батч событий с веба и по одному
 * публикует в «cinema» ← analytics.event — агрегирует Go-сервис
 * «Аналитик» (своя очередь, свои агрегаты). API ничего не хранит:
 * потеря батча не бьёт по продукту, поэтому без транзакционности —
 * publish и 202. Событие с мусорным типом до сюда не доходит
 * (ValidationPipe), больное событие умрёт в retry/parking очереди
 * Аналитика, не затронув соседей: одно сообщение = одно событие.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger('AnalyticsService');

  constructor(private readonly rabbit: AmqpConnection) {}

  ingest(batch: IngestAnalyticsDto): { accepted: number } {
    for (const event of batch.events) {
      const message: AnalyticsEventMessage = {
        ...event,
        type: event.type as AnalyticsEventMessage['type'],
        // конверт штампует идентичность во все события батча; трекер
        // флашит очередь до смены аккаунта, чтобы не смешивать
        aid: batch.aid,
        userId: batch.userId,
      };
      this.rabbit.publish('cinema', ANALYTICS_EVENT_RK, message, tracePublishOptions());
    }
    this.logger.debug(`ingest: ${batch.events.length} событий от ${batch.aid}`);
    return { accepted: batch.events.length };
  }
}
