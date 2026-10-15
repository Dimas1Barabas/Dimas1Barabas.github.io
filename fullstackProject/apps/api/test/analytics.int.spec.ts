import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import request from 'supertest';

import { AnalyticsController } from '../src/analytics/analytics.controller';
import { AnalyticsInsightsClient } from '../src/analytics/analytics-insights.client';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { RateLimitGuard } from '../src/ratelimiter/rate-limit.guard';
import { RateLimiterClient } from '../src/ratelimiter/ratelimiter.client';

/**
 * Интеграционный тест инжеста аналитики: полный HTTP-стек Nest с боевым
 * ValidationPipe (whitelist/transform) и гвардом лимитов поверх фейкового
 * Привратника; публикация в брокер — шпион. Проверяет контракт батча,
 * которым живёт веб-трекер: 202, штампы конверта, лимит на aid.
 */
describe('POST /api/analytics/events (integration)', () => {
  let app: INestApplication;
  let rabbit: { publish: jest.Mock };
  let ratelimiter: { check: jest.Mock };
  // витрину здесь не тестируем (это отдельный прокси-эндпоинт),
  // но DI контроллера требует клиент — подставляем болванку
  let insights: { insights: jest.Mock };

  const AID = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    rabbit = { publish: jest.fn() };
    ratelimiter = { check: jest.fn() };
    insights = { insights: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        AnalyticsService,
        { provide: AmqpConnection, useValue: rabbit },
        { provide: AnalyticsInsightsClient, useValue: insights },
        RateLimitGuard,
        { provide: RateLimiterClient, useValue: ratelimiter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    rabbit.publish.mockReset();
    ratelimiter.check.mockReset();
    ratelimiter.check.mockResolvedValue({ allowed: true, remaining: 29 });
  });

  it('202: каждое событие батча — отдельное сообщение cinema ← analytics.event', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({
        aid: AID,
        events: [
          { type: 'page_view', ts: '2026-10-12T10:00:00.000Z', route: 'home' },
          { type: 'seat_click', ts: '2026-10-12T10:00:05.000Z', seat: '5-7' },
        ],
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 2 });
    expect(rabbit.publish).toHaveBeenCalledTimes(2);
    const [exchange, routingKey] = rabbit.publish.mock.calls[0];
    expect(exchange).toBe('cinema');
    expect(routingKey).toBe('analytics.event');
  });

  it('конверт штампует aid во все события батча', async () => {
    await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({
        aid: AID,
        events: [{ type: 'booking_modal_open', ts: '2026-10-12T10:00:00.000Z' }],
      });

    const message = rabbit.publish.mock.calls[0][2];
    expect(message).toMatchObject({
      aid: AID,
      type: 'booking_modal_open',
    });
  });

  it('ключ корзины Привратника — aid из конверта, не ip', async () => {
    await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({
        aid: AID,
        events: [{ type: 'page_view', ts: '2026-10-12T10:00:00.000Z' }],
      });

    expect(ratelimiter.check).toHaveBeenCalledWith({
      action: 'analytics.ingest',
      key: AID,
    });
  });

  it('отказ Привратника — 429 с кодом rateLimited', async () => {
    ratelimiter.check.mockResolvedValueOnce({
      allowed: false,
      retryAfterMs: 2000,
      remaining: 0,
    });

    const res = await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({
        aid: AID,
        events: [{ type: 'page_view', ts: '2026-10-12T10:00:00.000Z' }],
      });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rateLimited');
    expect(rabbit.publish).not.toHaveBeenCalled();
  });

  it('400: неизвестный тип события отбрасывает батч до публикации', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({
        aid: AID,
        events: [{ type: 'миг', ts: '2026-10-12T10:00:00.000Z' }],
      });

    expect(res.status).toBe(400);
    expect(rabbit.publish).not.toHaveBeenCalled();
  });

  it('400: пустой батч и битный код места не проходят валидацию', async () => {
    const empty = await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({ aid: AID, events: [] });
    expect(empty.status).toBe(400);

    const badSeat = await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({
        aid: AID,
        events: [{ type: 'seat_click', ts: '2026-10-12T10:00:00.000Z', seat: 'ряд5' }],
      });
    expect(badSeat.status).toBe(400);
    expect(rabbit.publish).not.toHaveBeenCalled();
  });

  it('400: aid обязан быть uuid — иначе корзину не построить', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({
        aid: 'not-a-uuid',
        events: [{ type: 'page_view', ts: '2026-10-12T10:00:00.000Z' }],
      });
    expect(res.status).toBe(400);
  });

  it('лишние поля события срезаются whitelist' + '-ом, событие принимается', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/analytics/events')
      .send({
        aid: AID,
        extra: 'мусор конверта',
        events: [
          {
            type: 'page_dwell',
            ts: '2026-10-12T10:00:00.000Z',
            route: 'home',
            ms: 5000,
            hackerField: 'x',
          },
        ],
      });

    expect(res.status).toBe(202);
    const message = rabbit.publish.mock.calls[0][2];
    expect(message.hackerField).toBeUndefined();
    expect(message.extra).toBeUndefined();
  });
});
