import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { BonusTransaction } from '../src/bonus/bonus-transaction.entity';
import { ReferralsController } from '../src/referrals/referrals.controller';
import { ReferralsService } from '../src/referrals/referrals.service';
import { User } from '../src/users/user.entity';

/**
 * Интеграционный тест реферальной витрины: реальный HTTP-стек Nest
 * (роутинг, ValidationPipe, JWT-гвард → контроллер → сервис) на
 * in-memory фейках users/ledger. Проверяем контракт GET /referrals/my:
 * ленивая догенерация кода, маскированные email, тоталы и earned
 * от источника-ledger.
 */

type UserRow = Pick<
  User,
  | 'id'
  | 'email'
  | 'name'
  | 'role'
  | 'referralCode'
  | 'referredBy'
  | 'referralRewardedAt'
  | 'createdAt'
>;

class FakeUserRepo {
  rows: UserRow[] = [];
  saved: UserRow[] = [];

  async find(options: { where: { referredBy?: string } }): Promise<UserRow[]> {
    return this.rows
      .filter((r) => r.referredBy === options.where.referredBy)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
  }

  async findOneByOrFail(where: { id: string }): Promise<UserRow> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new Error('Пользователь не найден');
    return found;
  }

  async save(user: UserRow): Promise<UserRow> {
    this.saved.push(user);
    return user;
  }
}

/** ledger-фейк: только REFERRAL_EARNED_SQL через manager.query */
class FakeLedgerRepo {
  constructor(
    private readonly earned: (userId: string) => number,
  ) {}

  manager = {
    query: async (
      sql: string,
      params: string[],
    ): Promise<{ earned: string }[]> => {
      if (!sql.includes("reason = 'referral'")) {
        throw new Error(`unexpected query: ${sql}`);
      }
      return [{ earned: String(this.earned(params[0])) }];
    },
  };
}

describe('Рефералы: HTTP-интеграция витрины «Пригласить»', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let usersRepo: FakeUserRepo;
  let jwt: JwtService;

  /** пригласивший и его друзья */
  let host: UserRow;

  const seedUser = (overrides: Partial<UserRow> = {}): UserRow => {
    const row: UserRow = {
      id: randomUUID(),
      email: 'someone@example.com',
      name: 'Кто-то',
      role: 'user',
      referralCode: randomUUID().slice(0, 8).toUpperCase(),
      referredBy: null,
      referralRewardedAt: null,
      createdAt: new Date(),
      ...overrides,
    };
    usersRepo.rows.push(row);
    return row;
  };

  beforeAll(async () => {
    usersRepo = new FakeUserRepo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '2h' } }),
      ],
      controllers: [ReferralsController],
      providers: [
        ReferralsService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        {
          provide: getRepositoryToken(BonusTransaction),
          useValue: new FakeLedgerRepo(
            (userId) => (userId === 'host-1' ? 600 : 0),
          ),
        },
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: DataSource, useValue: {} },
        { provide: ConfigService, useValue: { get: (_k: string, def?: string) => def } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    jwt = moduleRef.get(JwtService);
    host = seedUser({
      id: 'host-1',
      email: 'host@example.com',
      name: 'Хост',
      referralCode: 'AB2CD3EF',
    });
    seedUser({
      email: 'bob@example.com',
      name: 'Боб',
      referredBy: 'host-1',
      referralCode: 'BBBBBBBB',
      referralRewardedAt: new Date(),
    });
    seedUser({
      email: 'carol@example.com',
      name: 'Кэрол',
      referredBy: 'host-1',
      referralCode: 'CCCCCCCC',
    });
    // чужой юзер — не должен попасть в витрину
    seedUser({ email: 'stranger@example.com', name: 'Чужак' });
  });

  afterAll(async () => {
    await app.close();
  });

  function bearerOf(userId: string): string {
    return `Bearer ${jwt.sign({ sub: userId, email: 'x@example.com' })}`;
  }

  it('без JWT — 401', () => {
    return request(app.getHttpServer())
      .get('/referrals/my')
      .expect(401);
  });

  it('витрина: код, размеры бонусов, тоталы, маскированные email', async () => {
    const res = await request(app.getHttpServer())
      .get('/referrals/my')
      .set('Authorization', bearerOf('host-1'))
      .expect(200);

    expect(res.body).toMatchObject({
      code: 'AB2CD3EF',
      bonusInviter: 300,
      bonusFriend: 100,
      totals: { invited: 2, paid: 1, earned: 600 },
    });
    expect(res.body.invited).toHaveLength(2);
    expect(res.body.invited[0]).toMatchObject({
      name: 'Боб',
      email: 'b***@example.com',
      paid: true,
    });
    expect(res.body.invited[1]).toMatchObject({
      name: 'Кэрол',
      email: 'c***@example.com',
      paid: false,
    });
    // чужие в витрину не попадают
    expect(JSON.stringify(res.body.invited)).not.toContain('Чужак');
  });

  it('юзер без кода получает его лениво и сохранённым', async () => {
    const legacy = seedUser({
      email: 'legacy@example.com',
      name: 'До рефералки',
      referralCode: null,
    });

    const res = await request(app.getHttpServer())
      .get('/referrals/my')
      .set('Authorization', bearerOf(legacy.id))
      .expect(200);

    expect(res.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(res.body.totals).toEqual({ invited: 0, paid: 0, earned: 0 });
    expect(usersRepo.saved).toHaveLength(1);
    expect(usersRepo.saved[0].id).toBe(legacy.id);
    expect(usersRepo.saved[0].referralCode).toBe(res.body.code);
  });
});
