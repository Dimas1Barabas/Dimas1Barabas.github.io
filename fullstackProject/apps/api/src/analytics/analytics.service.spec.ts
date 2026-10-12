import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Test } from '@nestjs/testing';

import { AnalyticsService } from './analytics.service';

/**
 * Сервис инжеста — тонкая труба: каждое событие батча уходит отдельным
 * сообщением в cinema ← analytics.event, конверт штампует aid/userId.
 */
describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let rabbit: { publish: jest.Mock };

  beforeEach(async () => {
    rabbit = { publish: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: AmqpConnection, useValue: rabbit },
      ],
    }).compile();
    service = moduleRef.get(AnalyticsService);
  });

  it('публикует каждое событие отдельным сообщением с rk analytics.event', () => {
    service.ingest({
      aid: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      events: [
        { type: 'page_view', ts: '2026-10-12T10:00:00.000Z', route: 'home' },
        { type: 'seat_click', ts: '2026-10-12T10:00:05.000Z', seat: '5-7' },
      ],
    });

    expect(rabbit.publish).toHaveBeenCalledTimes(2);
    for (const call of rabbit.publish.mock.calls) {
      expect(call[0]).toBe('cinema');
      expect(call[1]).toBe('analytics.event');
    }
  });

  it('штампует aid и userId конверта во все события батча', () => {
    const aid = '11111111-1111-4111-8111-111111111111';
    const userId = '22222222-2222-4222-8222-222222222222';
    service.ingest({
      aid,
      userId,
      events: [
        { type: 'booking_modal_open', ts: '2026-10-12T10:00:00.000Z' },
      ],
    });

    const message = rabbit.publish.mock.calls[0][2];
    expect(message).toMatchObject({ type: 'booking_modal_open', aid, userId });
  });

  it('возвращает количество принятых событий', () => {
    const res = service.ingest({
      aid: '11111111-1111-4111-8111-111111111111',
      events: [
        { type: 'page_view', ts: '2026-10-12T10:00:00.000Z', route: 'home' },
        { type: 'page_dwell', ts: '2026-10-12T10:00:10.000Z', route: 'home', ms: 9000 },
        { type: 'page_view', ts: '2026-10-12T10:00:12.000Z', route: 'bookings' },
      ],
    });
    expect(res).toEqual({ accepted: 3 });
  });
});
