import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AuthController } from '../src/auth/auth.controller';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { User } from '../src/users/user.entity';

/**
 * Интеграционный тест авторизации: реальный HTTP-стек Nest
 * (роутинг, ValidationPipe, контроллер → сервис), репозиторий — Map-фейк.
 */

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
      controllers: [AuthController],
      providers: [
        UsersService,
        AuthService,
        { provide: ConfigService, useValue: { get: (_k: string, def?: string) => def } },
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
});
