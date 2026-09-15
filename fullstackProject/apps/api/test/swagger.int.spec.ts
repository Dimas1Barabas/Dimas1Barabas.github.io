import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingStream } from '../src/bookings/booking-stream';
import { BookingsService } from '../src/bookings/bookings.service';
import { SeatsController } from '../src/bookings/seats.controller';
import { HealthController } from '../src/health/health.controller';
import { MoviesController } from '../src/movies/movies.controller';
import { MoviesService } from '../src/movies/movies.service';
import { RedisService } from '../src/redis/redis.service';
import { ReviewsController } from '../src/reviews/reviews.controller';
import { ReviewsService } from '../src/reviews/reviews.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { setupSwagger } from '../src/swagger';

/**
 * Интеграционный тест Swagger-документации: все контроллеры настоящего API
 * (метаданные маршрутов — то, из чего строится спека), гварды — как в боевом
 * app.module.ts. Сервисы — пустышки: бизнес-маршруты не вызываются, читаются
 * только /api/docs и /api/docs-json.
 */

describe('Swagger UI /api/docs (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'dev-cine-secret' })],
      controllers: [
        MoviesController,
        BookingsController,
        SeatsController,
        AuthController,
        ReviewsController,
        HealthController,
      ],
      providers: [
        { provide: MoviesService, useValue: {} },
        { provide: BookingsService, useValue: {} },
        { provide: BookingStream, useValue: {} },
        { provide: ReviewsService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: AuthService, useValue: {} },
        { provide: RedisService, useValue: {} },
        { provide: DataSource, useValue: {} },
        { provide: AmqpConnection, useValue: {} },
        { provide: ConfigService, useValue: { get: (_k: string, def?: string) => def } },
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('200: UI отдаётся без Authorization — гвард его не трогает', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs');

    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
  });

  it('200: /api/docs-json — валидная OpenAPI 3 спека с заголовком проекта', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info.title).toBe('CineBooking API');
    expect(res.body.info.version).toBe('1.0.0');
  });

  it('спека накрывает все маршруты API (с глобальным префиксом api)', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    const paths = Object.keys(res.body.paths as Record<string, unknown>);

    const expected = [
      '/api/movies',
      '/api/movies/{id}',
      '/api/movies/{movieId}/reviews',
      '/api/movies/{movieId}/reviews/{id}',
      '/api/bookings',
      '/api/bookings/my',
      '/api/bookings/stats',
      '/api/bookings/stream',
      '/api/bookings/{id}/pay',
      '/api/bookings/{id}/cancel',
      '/api/sessions/{sessionId}/seats',
      '/api/auth/register',
      '/api/auth/login',
      '/api/health',
    ];
    expect(paths).toEqual(expect.arrayContaining(expected));
  });

  it('securitySchemes: описан bearer (JWT из /api/auth/login)', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');

    expect(res.body.components.securitySchemes).toMatchObject({
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    });
  });
});
