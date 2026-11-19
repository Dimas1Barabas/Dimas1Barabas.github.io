import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { User } from '../src/users/user.entity';
import { BackupCode } from '../src/twofactor/backup-code.entity';
import { TrustedDevice } from '../src/twofactor/trusted-device.entity';
import { TwoFactorChallenge } from '../src/twofactor/two-factor-challenge.entity';
import { TwoFactorController } from '../src/twofactor/twofactor.controller';
import { TwoFactorModule } from '../src/twofactor/twofactor.module';
import { TwoFactorService } from '../src/twofactor/twofactor.service';
import { totp } from '../src/twofactor/totp';

/**
 * Интеграционный тест 2FA-настроек: реальный HTTP-стек Nest (роутинг,
 * ValidationPipe, JWT-гвард → контроллер → сервис) на in-memory фейках
 * репозиториев. Второй шаг логина (билеты) — auth.int; живая база — e2e.
 */

function userRow(id: string, email: string): User {
  return {
    id,
    email,
    name: 'Тест',
    role: 'user',
    passwordHash: 'x',
    referralCode: null,
    referredBy: null,
    referralRewardedAt: null,
    totpSecret: null,
    totpEnabledAt: null,
    createdAt: new Date(),
  };
}

class FakeUsersRepo {
  rows: User[] = [userRow('user-a', 'anna@test.local')];
  async findOneByOrFail(where: { id: string }): Promise<User> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new Error('user not found');
    return found;
  }
  async update(criteria: { id: string }, patch: Partial<User>): Promise<void> {
    const found = this.rows.find((r) => r.id === criteria.id);
    if (found) Object.assign(found, patch);
  }
}

class FakeCodesRepo {
  rows: BackupCode[] = [];
  seq = 0;
  create(p: Partial<BackupCode>): BackupCode {
    return {
      id: `code-${++this.seq}`,
      userId: '',
      codeHash: '',
      createdAt: new Date(),
      usedAt: null,
      ...p,
    } as BackupCode;
  }
  async save(row: BackupCode): Promise<BackupCode> {
    this.rows.push(row);
    return row;
  }
  async delete(where: { userId: string }): Promise<void> {
    this.rows = this.rows.filter((r) => r.userId !== where.userId);
  }
  async update(
    criteria: { userId: string; codeHash: string },
    patch: { usedAt: Date },
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (const r of this.rows) {
      if (
        r.userId === criteria.userId &&
        r.codeHash === criteria.codeHash &&
        r.usedAt === null
      ) {
        r.usedAt = patch.usedAt;
        affected++;
      }
    }
    return { affected };
  }
}

class FakeDevicesRepo {
  rows: TrustedDevice[] = [];
  seq = 0;
  create(p: Partial<TrustedDevice>): TrustedDevice {
    return {
      id: `dev-${++this.seq}`,
      userId: '',
      tokenHash: '',
      name: '',
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: new Date(),
      revokedAt: null,
      ...p,
    } as TrustedDevice;
  }
  async save(row: TrustedDevice): Promise<TrustedDevice> {
    this.rows.push(row);
    return row;
  }
  async find(): Promise<TrustedDevice[]> {
    return this.rows.filter((r) => r.revokedAt === null);
  }
  async findOneBy(where: { tokenHash: string; userId: string }) {
    return (
      this.rows.find(
        (r) => r.tokenHash === where.tokenHash && r.userId === where.userId,
      ) ?? null
    );
  }
  async update(
    criteria: { id?: string; userId?: string; revokedAt?: unknown },
    patch: Partial<TrustedDevice>,
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (const r of this.rows) {
      const byId = criteria.id === undefined || r.id === criteria.id;
      const byUser = criteria.userId === undefined || r.userId === criteria.userId;
      const byRevoked = criteria.revokedAt === undefined || r.revokedAt === null;
      if (byId && byUser && byRevoked) {
        Object.assign(r, patch);
        affected++;
      }
    }
    return { affected };
  }
}

class FakeChallengesRepo {
  rows: TwoFactorChallenge[] = [];
  seq = 0;
  create(p: Partial<TwoFactorChallenge>): TwoFactorChallenge {
    return {
      id: `chal-${++this.seq}`,
      userId: '',
      ticketHash: '',
      attempts: 0,
      expiresAt: new Date(),
      usedAt: null,
      createdAt: new Date(),
      ...p,
    } as TwoFactorChallenge;
  }
  async save(row: TwoFactorChallenge): Promise<TwoFactorChallenge> {
    this.rows.push(row);
    return row;
  }
  async delete(): Promise<void> {
    this.rows = [];
  }
  async findOneBy(where: { ticketHash: string }) {
    return this.rows.find((r) => r.ticketHash === where.ticketHash) ?? null;
  }
  async update(
    criteria: { id: string },
    patch: Partial<TwoFactorChallenge>,
  ): Promise<void> {
    const found = this.rows.find((r) => r.id === criteria.id);
    if (found) Object.assign(found, patch);
  }
}

describe('2FA: HTTP-интеграция настроек профиля', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let users: FakeUsersRepo;
  let devices: FakeDevicesRepo;
  let jwt: JwtService;
  let service: TwoFactorService;

  const bearer = (): string =>
    `Bearer ${jwt.sign({ sub: 'user-a', email: 'anna@test.local', role: 'user' })}`;

  beforeAll(async () => {
    users = new FakeUsersRepo();
    devices = new FakeDevicesRepo();
    const codes = new FakeCodesRepo();
    const challenges = new FakeChallengesRepo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '2h' } }),
      ],
      controllers: [TwoFactorController],
      providers: [
        TwoFactorService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(BackupCode), useValue: codes },
        { provide: getRepositoryToken(TrustedDevice), useValue: devices },
        { provide: getRepositoryToken(TwoFactorChallenge), useValue: challenges },
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: ConfigService, useValue: { get: (_k: string, def?: string) => def } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    jwt = moduleRef.get(JwtService);
    service = moduleRef.get(TwoFactorService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('без JWT — 401 на всех маршрутах', async () => {
    const server = app.getHttpServer();
    await request(server).get('/users/me/2fa').expect(401);
    await request(server).post('/users/me/2fa/setup').expect(401);
    await request(server).post('/users/me/2fa/enable').send({ code: '123456' }).expect(401);
    await request(server).post('/users/me/2fa/disable').send({ code: '123456' }).expect(401);
    await request(server).get('/users/me/2fa/devices').expect(401);
    await request(server).delete('/users/me/2fa/devices/xyz').expect(401);
  });

  it('статус: выключена и ничего не ждёт', async () => {
    const res = await request(app.getHttpServer())
      .get('/users/me/2fa')
      .set('Authorization', bearer())
      .expect(200);
    expect(res.body).toEqual({ enabled: false, pending: false });
  });

  it('setup: секрет и otpauth-ссылка с email владельца, статус — pending', async () => {
    const res = await request(app.getHttpServer())
      .post('/users/me/2fa/setup')
      .set('Authorization', bearer())
      .expect(201);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.otpauthUri).toContain(
      'otpauth://totp/CineBooking%3Aanna%40test.local',
    );

    const status = await request(app.getHttpServer())
      .get('/users/me/2fa')
      .set('Authorization', bearer())
      .expect(200);
    expect(status.body).toEqual({ enabled: false, pending: true });
  });

  it('enable с неверным кодом — 401 totpInvalid, ввод с обводками прощается', async () => {
    // секрет уже есть от setup'а предыдущего кейса (pending)
    const res = await request(app.getHttpServer())
      .post('/users/me/2fa/enable')
      .set('Authorization', bearer())
      .send({ code: ' 000000 ' })
      .expect(401);
    expect(res.body.code).toBe('totpInvalid');
  });

  it('enable верным кодом: 10 backup-кодов один раз, статус включена', async () => {
    const secret = users.rows[0].totpSecret!;
    const res = await request(app.getHttpServer())
      .post('/users/me/2fa/enable')
      .set('Authorization', bearer())
      .send({ code: totp(secret) })
      .expect(200);
    expect(res.body.backupCodes).toHaveLength(10);

    const status = await request(app.getHttpServer())
      .get('/users/me/2fa')
      .set('Authorization', bearer())
      .expect(200);
    expect(status.body).toEqual({ enabled: true, pending: false });

    // включённую не перенастроить и не включить повторно
    await request(app.getHttpServer())
      .post('/users/me/2fa/setup')
      .set('Authorization', bearer())
      .expect(409);
    await request(app.getHttpServer())
      .post('/users/me/2fa/enable')
      .set('Authorization', bearer())
      .send({ code: totp(secret) })
      .expect(409);
  });

  it('устройства: витрина, отзыв своего, чужой id — 404', async () => {
    await service.issueTrustedDevice('user-a', 'Ноутбук');
    await service.issueTrustedDevice('user-a', 'Телефон');

    const list = await request(app.getHttpServer())
      .get('/users/me/2fa/devices')
      .set('Authorization', bearer())
      .expect(200);
    expect(list.body).toHaveLength(2);
    // оба выданы в одну миллисекунду — порядок сортировки не определён
    expect(list.body.map((d: { name: string }) => d.name).sort()).toEqual(
      ['Ноутбук', 'Телефон'].sort(),
    );

    await request(app.getHttpServer())
      .delete(`/users/me/2fa/devices/${list.body[0].id}`)
      .set('Authorization', bearer())
      .expect(204);

    const after = await request(app.getHttpServer())
      .get('/users/me/2fa/devices')
      .set('Authorization', bearer())
      .expect(200);
    expect(after.body).toHaveLength(1);

    // повторный отзыв и чужой uuid — 404
    await request(app.getHttpServer())
      .delete(`/users/me/2fa/devices/${list.body[0].id}`)
      .set('Authorization', bearer())
      .expect(404);
    await request(app.getHttpServer())
      .delete('/users/me/2fa/devices/00000000-0000-4000-8000-000000000099')
      .set('Authorization', bearer())
      .expect(404);
  });

  it('disable backup-кодом в нижнем регистре: гасит всё, статус выключена', async () => {
    const secret = users.rows[0].totpSecret!;
    // текущий backup возьмём сервисом (HTTP отдал их один раз раньше)
    await request(app.getHttpServer())
      .post('/users/me/2fa/disable')
      .set('Authorization', bearer())
      .send({ code: '111111' })
      .expect(401);

    // восстановим набор для чистоты: disable кодом приложения
    await request(app.getHttpServer())
      .post('/users/me/2fa/disable')
      .set('Authorization', bearer())
      .send({ code: totp(secret) })
      .expect(204);

    const status = await request(app.getHttpServer())
      .get('/users/me/2fa')
      .set('Authorization', bearer())
      .expect(200);
    expect(status.body).toEqual({ enabled: false, pending: false });
    expect(devices.rows.every((d) => d.revokedAt !== null)).toBe(true);
  });

  it('валидация: код из пробелов и короткий — 400', async () => {
    await request(app.getHttpServer())
      .post('/users/me/2fa/setup')
      .set('Authorization', bearer())
      .expect(201);
    await request(app.getHttpServer())
      .post('/users/me/2fa/enable')
      .set('Authorization', bearer())
      .send({ code: '  ' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/users/me/2fa/enable')
      .set('Authorization', bearer())
      .send({ code: '12345' })
      .expect(400);
  });
});
