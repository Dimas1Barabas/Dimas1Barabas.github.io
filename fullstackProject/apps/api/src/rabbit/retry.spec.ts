import { Logger, NotFoundException } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import {
  MAX_ATTEMPTS,
  RETRY_HEADER,
  readAttempts,
  retryErrorHandler,
} from './retry';

/**
 * Механика retry/parking для консьюмеров: при сбое обработки сообщение
 * уезжает в `<rk>.retry` (TTL-возврат в рабочую очередь), «ядовитое»
 * или исчерпавшее попытки — в `<rk>.parking`, исходное подтверждается.
 */

Logger.overrideLogger(false); // warn-логи механики в тестах не нужны

interface Published {
  exchange: string;
  routingKey: string;
  options: {
    contentType?: string;
    persistent?: boolean;
    headers?: Record<string, unknown>;
  };
}

/** канал-двойник: помнит публикации и ack'и */
function makeChannel(): {
  channel: Channel;
  published: Published[];
  state: { acked: number };
} {
  const published: Published[] = [];
  const state = { acked: 0 };
  const channel = {
    publish(exchange: string, routingKey: string, _content: Buffer, options: Published['options']) {
      published.push({ exchange, routingKey, options });
    },
    ack() {
      state.acked++;
    },
  } as unknown as Channel;
  return { channel, published, state };
}

function makeMsg(headers: Record<string, unknown> = {}): ConsumeMessage {
  return {
    content: Buffer.from('{"bookingId":"b-1"}'),
    properties: { contentType: 'application/json', headers },
  } as ConsumeMessage;
}

describe('readAttempts', () => {
  it('0 — у оригинала без заголовка', () => {
    expect(readAttempts(makeMsg())).toBe(0);
    expect(readAttempts(makeMsg({}))).toBe(0);
  });

  it('число из заголовка x-retry-count', () => {
    expect(readAttempts(makeMsg({ [RETRY_HEADER]: 2 }))).toBe(2);
  });

  it('мусор в заголовке считается нулём', () => {
    expect(readAttempts(makeMsg({ [RETRY_HEADER]: 'много' }))).toBe(0);
  });
});

describe('retryErrorHandler: маршрут упавшего сообщения', () => {
  it('транзиентная ошибка → <rk>.retry со счётчиком 1 и ack', () => {
    const { channel, published, state } = makeChannel();
    const handler = retryErrorHandler('booking.processed');

    handler(channel, makeMsg(), new Error('connection refused'));

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      exchange: 'cinema',
      routingKey: 'booking.processed.retry',
    });
    expect(published[0].options.headers).toMatchObject({
      [RETRY_HEADER]: 1,
      'x-last-error': 'connection refused',
    });
    expect(published[0].options.persistent).toBe(true);
    expect(published[0].options.contentType).toBe('application/json');
    expect(state.acked).toBe(1);
  });

  it('ретраится, пока попыток меньше MAX_ATTEMPTS', () => {
    const { channel, published } = makeChannel();
    const handler = retryErrorHandler('booking.refunded');

    handler(channel, makeMsg({ [RETRY_HEADER]: 1 }), new Error('timeout'));

    expect(published[0].routingKey).toBe('booking.refunded.retry');
    expect(published[0].options.headers?.[RETRY_HEADER]).toBe(2);
  });

  it(`попытка ${MAX_ATTEMPTS} — последняя: дальше parking`, () => {
    const { channel, published } = makeChannel();
    const handler = retryErrorHandler('booking.processed');

    handler(
      channel,
      makeMsg({ [RETRY_HEADER]: MAX_ATTEMPTS - 1 }),
      new Error('всё ещё плохо'),
    );

    expect(published[0].routingKey).toBe('booking.processed.parking');
    expect(published[0].options.headers?.[RETRY_HEADER]).toBe(MAX_ATTEMPTS);
  });

  it('poison (бронь не найдена) — в parking без единого ретрая', () => {
    const { channel, published } = makeChannel();
    const handler = retryErrorHandler('booking.processed');

    handler(channel, makeMsg(), new NotFoundException('Бронь не найдена'));

    expect(published[0].routingKey).toBe('booking.processed.parking');
  });

  it('чужие заголовки копируются в новую публикацию', () => {
    const { channel, published } = makeChannel();
    const handler = retryErrorHandler('booking.processed');

    handler(channel, makeMsg({ 'x-custom': 'да' }), new Error('сбой'));

    expect(published[0].options.headers).toMatchObject({ 'x-custom': 'да' });
  });
});
