import { RETRY_TTL_MS } from './retry';
import { withRetryTopology } from './rabbitmq.config';

/**
 * Форма retry-топологии, которую объявляет withRetryTopology:
 * на каждую рабочую очередь — РОВНО ОДНА декларация .retry/.parking.
 *
 * Регрессия 406: очередь, слушающая несколько rk
 * (api.recommendations.signals: booking.confirmed + review.created),
 * раньше получала по декларации .retry НА КАЖДЫЙ rk — с разными
 * x-dead-letter-routing-key. Брокер на вторую декларацию той же
 * очереди отвечал 406 PRECONDITION_FAILED, канал пересоздавался
 * бесконечно; поймано live-int против живого RabbitMQ (03.10).
 */

describe('withRetryTopology', () => {
  it('один rk: retry и parking, бинды на <rk>.retry/.parking', () => {
    const [retry, parking] = withRetryTopology('api.booking.processed', 'booking.processed');

    expect(retry).toMatchObject({
      name: 'api.booking.processed.retry',
      exchange: 'cinema',
      routingKey: 'booking.processed.retry',
    });
    expect(retry.options?.arguments).toEqual({
      'x-message-ttl': RETRY_TTL_MS,
      'x-dead-letter-exchange': 'cinema',
      'x-dead-letter-routing-key': 'booking.processed',
    });
    expect(parking).toMatchObject({
      name: 'api.booking.processed.parking',
      routingKey: 'booking.processed.parking',
    });
  });

  it('массив rk: декларации уникальны по имени — по одной на очередь', () => {
    const queues = withRetryTopology('api.recommendations.signals', [
      'recommendation.booking.confirmed',
      'recommendation.review.created',
    ]);

    // ядро регрессии: до фикса здесь было 4 записи с дублями имён
    const names = queues.map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([
      'api.recommendations.signals.parking',
      'api.recommendations.signals.retry',
    ]);
  });

  it('массив rk: retry биндится на <rk>.retry каждого потока', () => {
    const [retry] = withRetryTopology('q', ['rk.one', 'rk.two']);
    expect(retry.routingKey).toEqual(['rk.one.retry', 'rk.two.retry']);
  });

  it('массив rk: parking биндится на <rk>.parking каждого потока', () => {
    const [, parking] = withRetryTopology('q', ['rk.one', 'rk.two']);
    expect(parking.routingKey).toEqual(['rk.one.parking', 'rk.two.parking']);
  });

  it('массив rk: dead-letter возвращает по первому rk (очередь слушает все)', () => {
    const [retry] = withRetryTopology('q', ['rk.one', 'rk.two']);
    expect(retry.options?.arguments).toMatchObject({
      'x-dead-letter-routing-key': 'rk.one',
    });
  });
});
