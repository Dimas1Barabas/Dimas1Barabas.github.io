import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { retryErrorHandler } from '../rabbit/retry';
import {
  RecommendationBookingEvent,
  RecommendationReviewEvent,
} from './recommendation-events';
import { RecommendationsService } from './recommendations.service';

/**
 * Слушает собственные сигналы КиноСоветнику (их публикуют BookingsService
 * и ReviewsService) и гасит кэш персонального топа зрителя: свежий сигнал
 * меняет профиль, значит «Вам понравится» перестало быть актуальным.
 * Модулям-издателям при этом не нужно знать о recommendations — связка
 * только через брокер, как у waitlist.
 */
@Injectable()
export class RecommendationsConsumer {
  constructor(private readonly recos: RecommendationsService) {}

  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: [
      'recommendation.booking.confirmed',
      'recommendation.review.created',
    ],
    queue: 'api.recommendations.signals',
    queueOptions: { durable: true },
    // rk выводится из сообщения: очередь слушает два потока сразу
    errorHandler: retryErrorHandler(),
  })
  async onSignal(
    event: RecommendationBookingEvent | RecommendationReviewEvent,
  ): Promise<void> {
    await this.recos.invalidateFor(event.userId);
  }
}
