import { Controller, INestApplication, Post, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RateLimited } from '../src/ratelimiter/rate-limited.decorator';
import { RateLimitGuard } from '../src/ratelimiter/rate-limit.guard';
import { RateLimiterClient } from '../src/ratelimiter/ratelimiter.client';

/**
 * Интеграционный тест гварда лимитов: полный HTTP-стек Nest (роутинг,
 * guard-конвейер, exception-фильтр) с фейковым gRPC-клиентом. Зонд-
 * контроллеры живут в спеке — в прод-файлы им дороги нет.
 */

@Controller('probe')
class ProbeController {
  /** лимитируемый маршрут: как POST /bookings и POST /auth/login в проде */
  @Post('limited')
  @UseGuards(RateLimitGuard)
  @RateLimited('bookings.create')
  limited(): { ok: true } {
    return { ok: true };
  }

  /** маршрут без метки: гвард нейтрален, Привратника не спрашиваем */
  @Post('free')
  free(): { ok: true } {
    return { ok: true };
  }
}

describe('RateLimitGuard (integration)', () => {
  let app: INestApplication;
  let ratelimiter: { check: jest.Mock };

  beforeAll(async () => {
    ratelimiter = { check: jest.fn(async () => ({ allowed: true })) };

    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: RateLimiterClient, useValue: ratelimiter }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    ratelimiter.check.mockReset();
    ratelimiter.check.mockResolvedValue({
      allowed: true,
      retryAfterMs: 0,
      remaining: 9,
    });
  });

  it('отказ Привратника — 429 с code rateLimited, retryAfterSec и заголовком Retry-After', async () => {
    ratelimiter.check.mockResolvedValueOnce({
      allowed: false,
      retryAfterMs: 1500,
      remaining: 0,
    });

    const res = await request(app.getHttpServer())
      .post('/api/probe/limited')
      .send({ email: 'BOT@TEST.LOCAL' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rateLimited');
    expect(res.body.retryAfterSec).toBe(2); // 1500 мс → ceil до секунд
    expect(res.body.message).toContain('Слишком часто');
    expect(res.headers['retry-after']).toBe('2');
    // ключ — email из тела, нормализованный
    expect(ratelimiter.check).toHaveBeenCalledWith({
      action: 'bookings.create',
      key: 'bot@test.local',
    });
  });

  it('сбой клиента — fail-open: запрос проходит', async () => {
    ratelimiter.check.mockRejectedValueOnce(new Error('deadline exceeded'));

    const res = await request(app.getHttpServer()).post('/api/probe/limited').send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('мусор в ответе (нет allowed) — пропуск, не гадаем', async () => {
    ratelimiter.check.mockResolvedValueOnce({} as never);

    const res = await request(app.getHttpServer()).post('/api/probe/limited').send({});
    expect(res.status).toBe(201);
  });

  it('маршрут без @RateLimited — Привратника не спрашиваем', async () => {
    const res = await request(app.getHttpServer()).post('/api/probe/free').send({});
    expect(res.status).toBe(201);
    expect(ratelimiter.check).not.toHaveBeenCalled();
  });

  it('retryAfterMs < 1 c — минимум 1 секунда ожидания', async () => {
    ratelimiter.check.mockResolvedValueOnce({ allowed: false, retryAfterMs: 40, remaining: 0 });

    const res = await request(app.getHttpServer()).post('/api/probe/limited').send({});
    expect(res.status).toBe(429);
    expect(res.body.retryAfterSec).toBe(1);
    expect(res.headers['retry-after']).toBe('1');
  });
});
