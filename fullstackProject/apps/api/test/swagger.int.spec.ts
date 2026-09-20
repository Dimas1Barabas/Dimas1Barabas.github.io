import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AdminController } from '../src/admin/admin.controller';
import { AdminStatsService } from '../src/admin/admin-stats.service';
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
import { PromosController } from '../src/promos/promos.controller';
import { PromosService } from '../src/promos/promos.service';
import { RedisService } from '../src/redis/redis.service';
import { ReviewsController } from '../src/reviews/reviews.controller';
import { ReviewsService } from '../src/reviews/reviews.service';
import { AuthService } from '../src/auth/auth.service';
import { TokensService } from '../src/tokens/tokens.service';
import { UsersController } from '../src/users/users.controller';
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
        UsersController,
        ReviewsController,
        AdminController,
        PromosController,
        HealthController,
      ],
      providers: [
        { provide: MoviesService, useValue: {} },
        { provide: AdminStatsService, useValue: {} },
        { provide: BookingsService, useValue: {} },
        { provide: BookingStream, useValue: {} },
        { provide: ReviewsService, useValue: {} },
        { provide: PromosService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: AuthService, useValue: {} },
        { provide: TokensService, useValue: {} },
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
      '/api/bookings/{id}/tickets',
      '/api/bookings/tickets/verify',
      '/api/sessions/{sessionId}/seats',
      '/api/auth/register',
      '/api/auth/login',
      '/api/auth/refresh',
      '/api/auth/logout',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/users/me',
      '/api/users/me/password',
      '/api/admin/stats',
      '/api/promos',
      '/api/promos/validate',
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

  it('схемы запросов: все DTO с required-полями и ограничениями', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    const schemas = res.body.components.schemas as Record<string, {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    }>;

    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'RegisterDto',
        'LoginDto',
        'CreateMovieDto',
        'CreateSessionDto',
        'CreateBookingDto',
        'CreateReviewDto',
        'CreatePromoDto',
        'ValidatePromoDto',
        'PayBookingDto',
        'UpdateProfileDto',
        'ChangePasswordDto',
        'ForgotPasswordDto',
        'ResetPasswordDto',
      ]),
    );

    // промокод в оплате опционален: required вообще не эмитится, когда
    // все поля опциональны — поэтому пустой дефолт
    expect(schemas.PayBookingDto.required ?? []).not.toContain('promoCode');
    // вид скидки — enum из одного источника
    expect(schemas.CreatePromoDto.properties?.kind).toMatchObject({
      enum: ['percent', 'fixed'],
    });

    // оценка — целое 1..5, обязательна
    expect(schemas.CreateReviewDto.required).toContain('rating');
    expect(schemas.CreateReviewDto.properties?.rating).toMatchObject({
      type: 'number',
      minimum: 1,
      maximum: 5,
    });

    // customerName опционален, места — массив 1..8
    expect(schemas.CreateBookingDto.required).not.toContain('customerName');
    expect(schemas.CreateBookingDto.properties?.seats).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 8,
    });

    // nested-сеансы в фильме — $ref на свою схему
    expect(schemas.CreateMovieDto.properties?.sessions).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/CreateSessionDto' },
    });
  });

  it('ответные схемы: сущности каталога, броней, отзывов и логина', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    const schemas = res.body.components.schemas as Record<string, unknown>;

    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'MovieDto',
        'SessionDto',
        'UserDto',
        'BookingDto',
        'ReviewDto',
        'SeatMapDto',
        'LoginResult',
        'AdminStatsResultDto',
        'AdminStatsDto',
        'AdminTotalsDto',
        'PromoDto',
        'PromoPreviewDto',
      ]),
    );

    // статусная машина — enum в доке
    const bookingStatus = (schemas.BookingDto as {
      properties: { status: { enum?: string[] } };
    }).properties.status.enum;
    expect(bookingStatus).toEqual(
      expect.arrayContaining(['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED']),
    );

    // nullable-поля брони не потерялись
    const props = (schemas.BookingDto as {
      properties: Record<string, { nullable?: boolean }>;
    }).properties;
    expect(props.expiresAt.nullable).toBe(true);
  });

  it('security: мутации за bearer, витрина открыта', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    const paths = res.body.paths as Record<
      string,
      Record<string, {
        security?: unknown[];
        responses?: Record<string, unknown>;
        parameters?: { name: string }[];
      }>
    >;

    // закрытое
    expect(paths['/api/bookings'].post.security).toEqual([{ bearer: [] }]);
    expect(paths['/api/bookings/my'].get.security).toEqual([{ bearer: [] }]);
    expect(paths['/api/movies/{movieId}/reviews'].post.security).toEqual([
      { bearer: [] },
    ]);

    // открытое — секции security нет вовсе
    expect(paths['/api/movies'].get.security).toBeUndefined();
    expect(paths['/api/bookings/stream'].get.security).toBeUndefined();
    expect(paths['/api/auth/login'].post.security).toBeUndefined();
    // refresh — @Public: протухший access сюда и не доехал бы
    expect(paths['/api/auth/refresh'].post.security).toBeUndefined();
    // восстановление пароля начинается без токена по определению
    expect(paths['/api/auth/forgot-password'].post.security).toBeUndefined();
    expect(paths['/api/auth/reset-password'].post.security).toBeUndefined();

    // logout за bearer — гасит refresh-сессию владельца
    expect(paths['/api/auth/logout'].post.security).toEqual([{ bearer: [] }]);

    // личный кабинет — только владелец по клеймам токена
    expect(paths['/api/users/me'].patch.security).toEqual([{ bearer: [] }]);
    expect(paths['/api/users/me/password'].put.security).toEqual([
      { bearer: [] },
    ]);

    // админские эндпоинты за bearer и документируют 403
    expect(paths['/api/movies'].post.responses).toHaveProperty('403');
    expect(paths['/api/admin/stats'].get.security).toEqual([{ bearer: [] }]);
    expect(paths['/api/admin/stats'].get.responses).toHaveProperty('403');
    expect(paths['/api/promos'].post.security).toEqual([{ bearer: [] }]);
    expect(paths['/api/promos'].post.responses).toHaveProperty('403');

    // билеты: владельцу по JWT, сканер — только admin
    expect(paths['/api/bookings/{id}/tickets'].get.security).toEqual([
      { bearer: [] },
    ]);
    expect(paths['/api/bookings/tickets/verify'].post.security).toEqual([
      { bearer: [] },
    ]);
    expect(paths['/api/bookings/tickets/verify'].post.responses).toHaveProperty(
      '403',
    );

    // превью промокода — любой авторизованный (не админ)
    expect(paths['/api/promos/validate'].post.security).toEqual([{ bearer: [] }]);

    // limit задокументирован query-параметром
    const limitParam = paths['/api/bookings'].get.parameters?.find(
      (p) => p.name === 'limit',
    );
    expect(limitParam).toBeTruthy();
  });
});
