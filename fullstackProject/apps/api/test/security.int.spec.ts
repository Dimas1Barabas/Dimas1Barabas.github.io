import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { HealthController } from '../src/health/health.controller';
import { RedisService } from '../src/redis/redis.service';
import { setupHelmet } from '../src/security/helmet';

/**
 * Security-заголовки Helmet на живом HTTP-ответе. Мини-приложение из одного
 * @Public-роута (/api/health) с фейками зависимостей: проверяется конвейер
 * middleware, а не домен — источник заголовков тот же, что и в бою
 * (setupHelmet вызван и здесь, и в main.ts).
 *
 * CSP для Swagger UI проверяет swagger.int.spec (там поднимается docs);
 * сюда приходит только факт «директивы не пустые и не дефолтно-опасные».
 */

describe('Helmet security-заголовки (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DataSource, useValue: { query: jest.fn(async () => []) } },
        { provide: RedisService, useValue: { ping: jest.fn(async () => true) } },
        { provide: AmqpConnection, useValue: { connected: true } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    setupHelmet(app);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('nosniff: браузер не нюхает тип содержимого ответа', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('кликджекинг: X-Frame-Options SAMEORIGIN + frame-ancestors в CSP', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');

    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toContain(
      "frame-ancestors 'self'",
    );
  });

  it('HSTS присутствует: на http браузер игнорирует, на https-деплое заработает', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');

    expect(res.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('CSP: скрипты только свои, inline-обработчики и плагины запрещены', async () => {
    const csp = (await request(app.getHttpServer()).get('/api/health')).headers[
      'content-security-policy'
    ];

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("object-src 'none'");
    // ослабление только там, где Swagger UI не может иначе:
    // инжект <style> из JS. Скрипты — строго 'self', без unsafe-inline
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('UIR снята: http-стенд не должен апгрейдить свои сабресурсы на https', async () => {
    const csp = (await request(app.getHttpServer()).get('/api/health')).headers[
      'content-security-policy'
    ];

    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('изоляция origin: CORP и COOP, реферер не утекает', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');

    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('заголовки не только на 2xx: ошибка валидации уходит с тем же набором', async () => {
    // /api/health не имеет тела, но не-2xx проще поймать на 404:
    // NotFound отдаёт тот же конвейер middleware
    const res = await request(app.getHttpServer()).get('/api/nope');

    expect(res.status).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });
});
