import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { RefreshToken } from '../src/tokens/refresh-token.entity';
import { TokensService } from '../src/tokens/tokens.service';
import { User } from '../src/users/user.entity';
import { UsersController } from '../src/users/users.controller';
import { UsersService } from '../src/users/users.service';

/**
 * Интеграционный тест личного кабинета: PATCH /users/me и смена пароля.
 * Стенд повторяет auth.int.spec — глобальные гварды, ValidationPipe,
 * Map-фейки репозиториев (users + refresh_tokens).
 */

const TEST_SECRET = 'integration-test-secret';
const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

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

  async findOneBy(where: { email?: string; id?: string }): Promise<User | null> {
    return (
      this.rows.find(
        (r) =>
          (where.email === undefined || r.email === where.email) &&
          (where.id === undefined || r.id === where.id),
      ) ?? null
    );
  }
}

class FakeTokenRepo {
  seq = 0;
  rows: RefreshToken[] = [];

  create(p: Partial<RefreshToken>): RefreshToken {
    return {
      id: `rt-${++this.seq}`,
      createdAt: new Date(),
      revokedAt: null,
      ...p,
    } as RefreshToken;
  }

  async save(row: RefreshToken): Promise<RefreshToken> {
    this.rows.push(row);
    return row;
  }

  async findOneBy(where: { tokenHash?: string }): Promise<RefreshToken | null> {
    return this.rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
  }

  async update(
    where: Record<string, unknown>,
    set: Partial<RefreshToken>,
  ): Promise<{ affected: number }> {
    const matched = this.rows.filter((r) => this.matches(r, where));
    matched.forEach((r) => Object.assign(r, set));
    return { affected: matched.length };
  }

  async delete(where: Record<string, unknown>): Promise<{ affected: number }> {
    const matched = this.rows.filter((r) => this.matches(r, where));
    this.rows = this.rows.filter((r) => !matched.includes(r));
    return { affected: matched.length };
  }

  private matches(row: RefreshToken, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, cond]) => {
      const value = row[key as keyof RefreshToken];
      if (cond instanceof FindOperator) {
        if (cond.type === 'isNull') return value === null;
        if (cond.type === 'lessThan') {
          return (value as Date) < (cond.value as Date);
        }
        return false;
      }
      return value === cond;
    });
  }
}

describe('users: профиль и смена пароля (integration)', () => {
  let app: INestApplication;
  let repo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let jwt: JwtService;
  let alice: User;
  let aliceToken = '';

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    repo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: TEST_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [UsersController],
      providers: [
        UsersService,
        TokensService,
        JwtStrategy,
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
        { provide: getRepositoryToken(RefreshToken), useValue: tokenRepo },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    jwt = moduleRef.get(JwtService);

    const users = moduleRef.get(UsersService);
    alice = await users.register({
      email: 'alice@example.com',
      password: 'secret123',
      name: 'Алиса',
    });
    await users.register({
      email: 'bob@example.com',
      password: 'secret123',
      name: 'Боб',
    });
    aliceToken = await jwt.signAsync({
      sub: alice.id,
      email: alice.email,
      name: alice.name,
      role: alice.role,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('PATCH /api/users/me', () => {
    it('200: обновляет профиль, ответ — свежая пара с новыми клеймами', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/users/me')
        .set(bearer(aliceToken))
        .send({ name: 'Алиса Новая', email: 'alice@new.com' });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        email: 'alice@new.com',
        name: 'Алиса Новая',
      });
      expect(res.body).not.toHaveProperty('refreshToken');
      expect(res.body).not.toHaveProperty('passwordHash');

      // access несёт новые клеймы (в JWT живут email/name)
      const payload = jwt.decode<{ email: string; name: string }>(
        res.body.accessToken,
      );
      expect(payload.email).toBe('alice@new.com');
      expect(payload.name).toBe('Алиса Новая');

      // refresh-сессия ротировалась в cookie
      const cookies = (
        (res.headers['set-cookie'] as unknown as string[]) ?? []
      ).join('\n');
      expect(cookies).toContain('cine.refresh=');
    });

    it('409: email занят другим пользователем', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/users/me')
        .set(bearer(aliceToken))
        .send({ email: 'bob@example.com' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('emailTaken');
    });

    it('400: пустое тело — нечего обновлять', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/users/me')
        .set(bearer(aliceToken))
        .send({});

      expect(res.status).toBe(400);
    });

    it('401: без access-токена', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/users/me')
        .send({ name: 'Кто-то' });

      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/users/me/password', () => {
    it('200: хэш заменён, все прежние сессии отозваны, выдана новая пара', async () => {
      const tokens = app.get(TokensService);
      const oldPair = await tokens.issuePair(alice);

      const res = await request(app.getHttpServer())
        .put('/api/users/me/password')
        .set(bearer(aliceToken))
        .send({ currentPassword: 'secret123', newPassword: 'new-secret-9' });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: 'alice@new.com' });
      expect(res.body).not.toHaveProperty('refreshToken');

      // пароль в «БД» реально заменён
      const row = repo.rows.find((r) => r.id === alice.id)!;
      expect(await bcrypt.compare('new-secret-9', row.passwordHash)).toBe(true);

      // прежняя refresh-сессия отозвана (выход отовсюду)...
      const oldRow = tokenRepo.rows.find(
        (r) => r.tokenHash === sha256(oldPair.refreshToken),
      );
      expect(oldRow?.revokedAt).not.toBeNull();
      // ...а ответ выдал свежую строку для этого устройства
      const liveRows = tokenRepo.rows.filter((r) => r.revokedAt === null);
      expect(liveRows.length).toBeGreaterThanOrEqual(1);
    });

    it('403: неверный текущий пароль', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/users/me/password')
        .set(bearer(aliceToken))
        .send({ currentPassword: 'wrong-pass', newPassword: 'another-9' });

      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Неверный текущий пароль');
    });

    it('400: короткий новый пароль', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/users/me/password')
        .set(bearer(aliceToken))
        .send({ currentPassword: 'new-secret-9', newPassword: '123' });

      expect(res.status).toBe(400);
    });

    it('401: без access-токена', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/users/me/password')
        .send({ currentPassword: 'new-secret-9', newPassword: 'whatever-9' });

      expect(res.status).toBe(401);
    });
  });
});
