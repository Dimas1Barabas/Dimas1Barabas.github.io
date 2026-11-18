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
import { GiftCertificate } from '../src/gifts/gift-certificate.entity';
import { GiftsController } from '../src/gifts/gifts.controller';
import { GiftsService } from '../src/gifts/gifts.service';

/**
 * Интеграционный тест гифт-сертификатов: реальный HTTP-стек Nest
 * (роутинг, ValidationPipe, JWT-гвард → контроллер → сервис) на
 * in-memory фейках. Проверяем контракт POST /gifts, /gifts/activate
 * и GET /gifts/my: границы номинала, одноразовую активацию с гонкой
 * (проигравший получает причину), витрину с живым остатком.
 */

type CertRow = Pick<
  GiftCertificate,
  | 'id'
  | 'code'
  | 'nominalRub'
  | 'remainingRub'
  | 'status'
  | 'buyerUserId'
  | 'activatedByUserId'
  | 'activatedAt'
  | 'expiresAt'
  | 'createdAt'
  | 'updatedAt'
>;

class FakeCertsRepo {
  rows: CertRow[] = [];
  saved: CertRow[] = [];

  manager = {
    // активация — атомарный UPDATE по status='purchased' и живому сроку
    query: async (
      sql: string,
      params: string[],
    ): Promise<[{ id: string }[], number]> => {
      if (!sql.includes("SET status = 'active'")) {
        throw new Error(`unexpected query: ${sql}`);
      }
      const found = this.rows.find(
        (r) =>
          r.code === params[0] &&
          r.status === 'purchased' &&
          r.expiresAt.getTime() > Date.now(),
      );
      if (!found) return [[], 0];
      found.status = 'active';
      found.activatedByUserId = params[1];
      found.activatedAt = new Date();
      return [[{ id: found.id }], 1];
    },
  };

  create(partial: Partial<CertRow>): CertRow {
    return {
      id: randomUUID(),
      code: '',
      nominalRub: 0,
      remainingRub: 0,
      status: 'purchased',
      buyerUserId: '',
      activatedByUserId: null,
      activatedAt: null,
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...partial,
    };
  }

  async save(row: CertRow): Promise<CertRow> {
    this.rows.push(row);
    this.saved.push(row);
    return row;
  }

  async find(): Promise<CertRow[]> {
    return [...this.rows];
  }

  async findOneBy(where: { code?: string; id?: string }) {
    return this.rows.find((r) => r.code === where.code || r.id === where.id) ?? null;
  }

  async findOneByOrFail(where: { code?: string; id?: string }) {
    const found = await this.findOneBy(where);
    if (!found) throw new Error('Сертификат не найден');
    return found;
  }
}

describe('Гифты: HTTP-интеграция покупки/активации/витрины', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let certsRepo: FakeCertsRepo;
  let jwt: JwtService;

  const seedCert = (overrides: Partial<CertRow> = {}): CertRow => {
    const row: CertRow = {
      id: randomUUID(),
      code: `GIFT-SEEDED${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
      nominalRub: 2_000,
      remainingRub: 2_000,
      status: 'purchased',
      buyerUserId: 'user-1',
      activatedByUserId: null,
      activatedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    certsRepo.rows.push(row);
    return row;
  };

  beforeAll(async () => {
    certsRepo = new FakeCertsRepo();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '2h' } }),
      ],
      controllers: [GiftsController],
      providers: [
        GiftsService,
        { provide: getRepositoryToken(GiftCertificate), useValue: certsRepo },
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
  });

  afterAll(async () => {
    await app.close();
  });

  function bearerOf(userId: string): string {
    return `Bearer ${jwt.sign({ sub: userId, email: 'x@example.com' })}`;
  }

  it('без JWT — 401 на всех трёх маршрутах', async () => {
    const server = app.getHttpServer();
    await request(server).post('/gifts').send({ nominalRub: 1000 }).expect(401);
    await request(server)
      .post('/gifts/activate')
      .send({ code: 'GIFT-AB2CD3EF' })
      .expect(401);
    await request(server).get('/gifts/my').expect(401);
  });

  it('покупка: карта purchased с номиналом, кодом и годом срока', async () => {
    const res = await request(app.getHttpServer())
      .post('/gifts')
      .set('Authorization', bearerOf('user-1'))
      .send({ nominalRub: 1500 })
      .expect(201);

    expect(res.body).toMatchObject({
      nominalRub: 1500,
      remainingRub: 1500,
      status: 'purchased',
      activatedAt: null,
    });
    expect(res.body.code).toMatch(/^GIFT-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(certsRepo.saved).toHaveLength(1);
    expect(certsRepo.saved[0].buyerUserId).toBe('user-1');
    expect(
      Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt),
    ).toBeGreaterThanOrEqual(364 * 86_400_000);
  });

  it('некруглый номинал — 400 с сообщением логики', async () => {
    const res = await request(app.getHttpServer())
      .post('/gifts')
      .set('Authorization', bearerOf('user-1'))
      .send({ nominalRub: 1999 })
      .expect(400);

    expect(res.body.message).toMatch(/кратн/);
    expect(certsRepo.saved).toHaveLength(1);
  });

  it('активация: карта становится active и привязывается к получателю', async () => {
    const cert = seedCert({ code: 'GIFT-FR1END0' });

    const res = await request(app.getHttpServer())
      .post('/gifts/activate')
      .set('Authorization', bearerOf('friend-1'))
      .send({ code: ' gift-fr1end0 ' })
      .expect(200);

    expect(res.body).toMatchObject({ status: 'active', remainingRub: 2000 });
    expect(cert.activatedByUserId).toBe('friend-1');
    expect(cert.activatedAt).not.toBeNull();
  });

  it('повторная активация — 409 giftAlreadyActivated', async () => {
    const cert = seedCert({ status: 'active', activatedByUserId: 'friend-1' });

    const res = await request(app.getHttpServer())
      .post('/gifts/activate')
      .set('Authorization', bearerOf('friend-2'))
      .send({ code: cert.code })
      .expect(409);

    expect(res.body.code).toBe('giftAlreadyActivated');
    // владелец не сменился — активация одноразовая
    expect(cert.activatedByUserId).toBe('friend-1');
  });

  it('опечатка в коде — 404 giftNotFound', async () => {
    const res = await request(app.getHttpServer())
      .post('/gifts/activate')
      .set('Authorization', bearerOf('friend-1'))
      .send({ code: 'GIFT-NOPE1234' })
      .expect(404);

    expect(res.body.code).toBe('giftNotFound');
  });

  it('витрина: мои карты, подаренные коды и живой остаток', async () => {
    // свой юзер на тест — карты из предыдущих кейсов не мешают
    const viewer = 'viewer-1';
    // живая своя карта
    seedCert({
      code: 'GIFT-MYCARD0',
      buyerUserId: viewer,
      status: 'active',
      activatedByUserId: viewer,
      remainingRub: 700,
    });
    // потраченная своя
    seedCert({
      code: 'GIFT-SPENT00',
      buyerUserId: viewer,
      status: 'exhausted',
      activatedByUserId: viewer,
      remainingRub: 0,
    });
    // купленная мной, ещё не активированная — «подарена»
    seedCert({ code: 'GIFT-GIVEN00', buyerUserId: viewer, status: 'purchased' });
    // чужая — не попадает в витрину
    seedCert({
      code: 'GIFT-FOREIGN',
      buyerUserId: 'stranger',
      activatedByUserId: 'stranger',
      status: 'active',
    });

    const res = await request(app.getHttpServer())
      .get('/gifts/my')
      .set('Authorization', bearerOf(viewer))
      .expect(200);

    expect(res.body.cards.map((c: { code: string }) => c.code)).toEqual(
      expect.arrayContaining(['GIFT-MYCARD0', 'GIFT-SPENT00']),
    );
    expect(res.body.cards).toHaveLength(2);
    expect(res.body.given.map((c: { code: string }) => c.code)).toEqual([
      'GIFT-GIVEN00',
    ]);
    expect(res.body.totals).toEqual({ availableRub: 700, cards: 2, given: 1 });
    expect(JSON.stringify(res.body)).not.toContain('GIFT-FOREIGN');
  });
});
