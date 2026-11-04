import type Redis from 'ioredis';
import { BusEnvelope, RedisStreamBus } from './stream-bus';

/**
 * Юнит-тесты шины на фейковом ioredis: конструктору нужен только
 * publish (издатель) и duplicate() (подписчик). Доставку имитируем
 * вызовом обработчика 'message', пойманного через on().
 */
function makeBus(publishResult: Promise<number> = Promise.resolve(1)) {
  const state = {
    published: [] as BusEnvelope[],
    messageHandlers: [] as ((channel: string, raw: string) => void)[],
  };
  const subscriber = {
    on: jest.fn((event: string, cb: (channel: string, raw: string) => void) => {
      if (event === 'message') state.messageHandlers.push(cb);
    }),
    subscribe: jest.fn(async () => 'OK'),
    disconnect: jest.fn(),
  };
  const publisher = {
    publish: jest.fn((_channel: string, raw: string) => {
      state.published.push(JSON.parse(raw) as BusEnvelope);
      return publishResult;
    }),
    duplicate: jest.fn(() => subscriber),
  };

  const bus = new RedisStreamBus(publisher as unknown as Redis);

  /** кадр «от соседа» в подписку шины, как его отдал бы Redis */
  const deliver = (envelope: BusEnvelope): void => {
    for (const handler of state.messageHandlers) {
      handler('cine.api.streams', JSON.stringify(envelope));
    }
  };

  return { bus, state, subscriber, publisher, deliver };
}

describe('RedisStreamBus (unit)', () => {
  it('publish упаковывает конверт: канал шины, kind и автор', () => {
    const { bus, publisher, state } = makeBus();
    bus.publish('seat', { sessionId: 's-1' });
    expect(publisher.publish).toHaveBeenCalledWith(
      'cine.api.streams',
      expect.any(String),
    );
    expect(state.published[0].kind).toBe('seat');
    expect(state.published[0].payload).toEqual({ sessionId: 's-1' });
    expect(state.published[0].pod).toBeTruthy();
  });

  it('своё эхо не доходит до обработчика — локальные уже уведомлены', () => {
    const { bus, state, deliver } = makeBus();
    const handler = jest.fn();
    bus.subscribe('booking', handler);
    bus.publish('booking', { id: 'b-1' });
    // эхо собственного кадра: тот же pod-Id
    deliver({ ...state.published[0] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('чужой кадр доставляется обработчику своего kind', () => {
    const { bus, deliver } = makeBus();
    const seatHandler = jest.fn();
    const bookingHandler = jest.fn();
    bus.subscribe('seat', seatHandler);
    bus.subscribe('booking', bookingHandler);

    deliver({ pod: 'neighbour-1', kind: 'seat', payload: { sessionId: 's-2' } });
    expect(seatHandler).toHaveBeenCalledWith({ sessionId: 's-2' });
    expect(bookingHandler).not.toHaveBeenCalled();

    deliver({ pod: 'neighbour-1', kind: 'waitlist', payload: {} });
    expect(seatHandler).toHaveBeenCalledTimes(1); // обработчика нет — тишина
  });

  it('мусорный кадр канала не роняет процесс', () => {
    const { bus, state, deliver } = makeBus();
    const handler = jest.fn();
    bus.subscribe('seat', handler);
    for (const handler0 of state.messageHandlers) {
      expect(() => handler0('cine.api.streams', 'не-JSON{')).not.toThrow();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('сбой publish — не бросок: локальные слушатели уже уведомлены', async () => {
    const { bus } = makeBus(Promise.reject(new Error('redis ушёл')));
    expect(() => bus.publish('booking', { id: 'b-2' })).not.toThrow();
    // rejection обработан внутри publish — ждём микротаску, иначе jest
    // посчитает её необработанной и уронит тест
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('onModuleDestroy закрывает соединение подписки', () => {
    const { bus, subscriber } = makeBus();
    bus.onModuleDestroy();
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  });
});
