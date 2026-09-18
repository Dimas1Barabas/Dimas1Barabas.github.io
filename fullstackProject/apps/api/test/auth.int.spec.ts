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
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';
import { AuthController } from '../src/auth/auth.controller';
import { AuthUser } from '../src/auth/auth-user';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { RefreshToken } from '../src/tokens/refresh-token.entity';
import { TokensService } from '../src/tokens/tokens.service';
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

/**
 * Map-фейк refresh-репозитория с семантикой условного UPDATE
 * (IsNull/LessThan в критериях) — без этого не покрыть ротацию.
 */
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

const TEST_SECRET = 'integration-test-secret';

describe('POST /api/auth/* (integration)', () => {
  let app: INestApplication;
  let repo: FakeUserRepo;
  let tokenRepo: FakeTokenRepo;
  let jwt: JwtService;

  /** из Set-Cookie в Cookie-заголовок для следующего запроса */
  const cookieHeader = (res: request.Response): string =>
    ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');

  beforeAll(async () => {
    repo = new FakeUserRepo();
    tokenRepo = new FakeTokenRepo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: TEST_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [AuthController, ProbeController],
      providers: [
        UsersService,
        AuthService,
        TokensService,
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
        { provide: getRepositoryToken(RefreshToken), useValue: tokenRepo },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // контроллеры читают req.cookies — как в main.ts
    app.use(cookieParser());
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

    it('Set-Cookie: refresh уезжает в httpOnly-cookie, в теле его нет', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'secret123' });

      expect(res.status).toBe(200);
      const cookies = (
        (res.headers['set-cookie'] as unknown as string[]) ?? []
      ).join('\n');
      expect(cookies).toContain('cine.refresh=');
      expect(cookies).toContain('HttpOnly');
      expect(cookies).toContain('Path=/api/auth');
      expect(res.body).not.toHaveProperty('refreshToken');
      // в «БД» — хэш куки, не сам токен
      const rawRefresh = cookieHeader(res).split('=')[1] ?? '';
      const lastRow = tokenRepo.rows[tokenRepo.rows.length - 1];
      expect(lastRow.tokenHash).not.toBe(rawRefresh);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('200: ротация — новая пара и новая кука, access работает на зонде', async () => {
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'secret123' });
      const firstCookie = cookieHeader(login);

      const res = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', firstCookie);

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: 'alice@example.com' });
      expect(res.body).not.toHaveProperty('refreshToken');
      // кука ротировалась: новое значение, старая строка помечена revoked_at
      const newCookie = cookieHeader(res);
      expect(newCookie).toMatch(/^cine\.refresh=/);
      expect(newCookie).not.toBe(firstCookie);
      const oldHash = tokenRepo.rows.find(
        (r) => r.revokedAt !== null,
      );
      expect(oldHash).toBeTruthy();

      const probe = await request(app.getHttpServer())
        .get('/api/probe')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(probe.status).toBe(200);
      expect(probe.body.userId).toBe(
        repo.rows.find((r) => r.email === 'alice@example.com')?.id,
      );
    });

    it('401: переиспользование ротированной куки убивает и свежую сессию', async () => {
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'secret123' });
      const first = cookieHeader(login);

      const rotated = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', first);
      const second = cookieHeader(rotated);

      const reuse = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', first);
      expect(reuse.status).toBe(401);

      // reuse — улика компрометации: вторая, ни в чём не виноватая кука, тоже мертва
      const afterReuse = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', second);
      expect(afterReuse.status).toBe(401);
    });

    it('401: без куки сессии нет', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/refresh');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('204: гасит сессию — refresh после logout отклоняется', async () => {
      const login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@example.com', password: 'secret123' });
      const cookie = cookieHeader(login);
      const alice = repo.rows.find((r) => r.email === 'alice@example.com');
      const token = await jwt.signAsync({
        sub: alice?.id,
        email: alice?.email,
        name: alice?.name,
        role: alice?.role,
      });

      const res = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .set('Cookie', cookie);

      expect(res.status).toBe(204);
      // кука снята
      const cleared = (
        (res.headers['set-cookie'] as unknown as string[]) ?? []
      ).join('\n');
      expect(cleared).toContain('cine.refresh=;');

      const refresh = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set('Cookie', cookie);
      expect(refresh.status).toBe(401);
    });

    it('401: logout без access-токена закрыт глобальным гвардом', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/logout');

      expect(res.status).toBe(401);
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
