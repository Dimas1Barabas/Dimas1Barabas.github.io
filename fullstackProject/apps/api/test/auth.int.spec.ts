import {
  Controller,
  Get,
  INestApplication,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AuthController } from '../src/auth/auth.controller';
import { AuthUser } from '../src/auth/auth-user';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { UsersService } from '../src/users/users.service';
import { User } from '../src/users/user.entity';

/**
 * Интеграционный тест авторизации: реальный HTTP-стек Nest
 * (роутинг, ValidationPipe, контроллер → сервис), репозиторий — Map-фейк.
 *
 * Глобальные гварды реплицируются как в боевом app.module.ts — раньше их
 * здесь не было, и это маскировало баг: без @Public() на register/login
 * живой JwtAuthGuard резал вход 401, а тесты оставались зелёными.
 * ProbeController (без @Public) доказывает, что гвард в этом стенде живой.
 */

/** «Зонд»: охраняемый маршрут — без токена 401, с токеном пропускает */
@Controller('probe')
class ProbeController {
  @Get()
  check(@Req() req: { user?: AuthUser }) {
    return { userId: req.user?.id ?? null };
  }
}

class FakeUserRepo {
  rows: User[] = [];

  create(x: Partial<User>): User {
    return x as User;
  }

  async save(user: User): Promise<User> {
    if (!user.id) user.id = randomUUID();
    if (!user.createdAt) user.createdAt = new Date();
    if (!user.role) user.role = 'user';
    if (!this.rows.includes(user)) this.rows.push(user);
    return user;
  }

  async findOneBy(where: { email?: string }): Promise<User | null> {
    return this.rows.find((r) => r.email === where.email) ?? null;
  }
}

const TEST_SECRET = 'integration-test-secret';

describe('POST /api/auth/* (integration)', () => {
  let app: INestApplication;
  let repo: FakeUserRepo;
  let jwt: JwtService;

  beforeAll(async () => {
    repo = new FakeUserRepo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: TEST_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [AuthController, ProbeController],
      providers: [
        UsersService,
        AuthService,
        JwtStrategy,
        // как в app.module.ts: всё закрыто JWT по умолчанию, @Public открывает
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def?: string) =>
              key === 'JWT_SECRET' ? TEST_SECRET : def,
          },
        },
        { provide: getRepositoryToken(User), useValue: repo },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('201: отдаёт UserDto без passwordHash, пароль в БД хэширован', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'Alice@Example.com', password: 'secret123', name: 'Алиса' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      email: 'alice@example.com',
      name: 'Алиса',
      role: 'user',
    });
    expect(res.body).not.toHaveProperty('passwordHash');
    // админ сеется в onModuleInit — ищем Алису по email, а не по индексу
    const alice = repo.rows.find((r) => r.email === 'alice@example.com');
    expect(res.body.id).toBe(alice?.id);

    // в «БД» лежит bcrypt-хэш, а не открытый пароль
    expect(repo.rows[0].passwordHash).not.toBe('secret123');
    expect(repo.rows[0].passwordHash.startsWith('$2')).toBe(true);
  });

  it('409 emailTaken на повторную регистрацию того же email', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'alice@example.com', password: 'secret456', name: 'Дубль' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('emailTaken');
  });

  it('400: короткий пароль не проходит валидацию', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'x@example.com', password: '123', name: 'Икс' });

    expect(res.status).toBe(400);
  });

  it('400: кривой email не проходит валидацию', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: 'не-почта', password: 'secret123', name: 'Игрек' });

    expect(res.status).toBe(400);
  });

  describe('POST /api/auth/login', () => {
    it('200: {accessToken, user}; в токене — клеймы пользователя', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'secret123' });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        email: 'alice@example.com',
        role: 'user',
      });
      expect(res.body).not.toHaveProperty('passwordHash');

      const payload = jwt.decode<{
        sub: string;
        email: string;
        name: string;
        role: string;
      }>(res.body.accessToken);
      const alice = repo.rows.find((r) => r.email === 'alice@example.com');
      expect(payload.sub).toBe(alice?.id);
      expect(payload.email).toBe('alice@example.com');
      expect(payload.name).toBe('Алиса');
      expect(payload.role).toBe('user');
    });

    it('401: неверный пароль', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'wrong-pass' });

      expect(res.status).toBe(401);
    });

    it('401: неизвестный email — тот же ответ, что при неверном пароле', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'ghost@example.com', password: 'whatever' });

      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Неверный email или пароль');
    });
  });

  describe('глобальный гвард в этом стенде живой (зонд /api/probe)', () => {
    it('401: охраняемый маршрут без токена закрыт', async () => {
      const res = await request(app.getHttpServer()).get('/api/probe');

      expect(res.status).toBe(401);
    });

    it('200: с валидным токеном — req.user из клеймов', async () => {
      const alice = repo.rows.find((r) => r.email === 'alice@example.com');
      const token = await jwt.signAsync({
        sub: alice?.id,
        email: 'alice@example.com',
        name: 'Алиса',
        role: 'user',
      });

      const res = await request(app.getHttpServer())
        .get('/api/probe')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(alice?.id);
    });
  });

  // главная регрессия этого стенда: register/login выше ходят БЕЗ токена —
  // убери @Public() с них, и эти тесты покраснеют, как живой API
});
