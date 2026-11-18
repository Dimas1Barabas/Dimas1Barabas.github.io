import { BadRequestException } from '@nestjs/common';
import { AuthUser } from '../auth/auth-user';
import { GiftCertificate } from './gift-certificate.entity';
import { GiftRefusedError, GiftsService } from './gifts.service';

/**
 * Юнит-спек GiftsService на in-memory фейке репозитория: покупка с
 * ретраем коллизии кода, атомарная активация, витрина «мои», списание
 * и возврат — по тем же raw-SQL запросам, что идут в Postgres (фейк
 * различает их по тексту). Семантика гонок проверяется состояниями:
 * выигравший видит строки RETURNING, проигравший — пустой массив.
 */

const USER: AuthUser = { id: 'user-1', email: 'a@x.io', role: 'user' } as AuthUser;
const FRIEND: AuthUser = { id: 'friend-1', email: 'b@x.io', role: 'user' } as AuthUser;

function cert(overrides: Partial<GiftCertificate> = {}): GiftCertificate {
  return {
    id: 'cert-1',
    code: 'GIFT-AB2CD3EF',
    nominalRub: 2_000,
    remainingRub: 2_000,
    status: 'purchased',
    buyerUserId: USER.id,
    activatedByUserId: null,
    activatedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as GiftCertificate;
}

/** трата: сколько сняли с карты в конкретной оплате */
interface SpendRow {
  certificateId: string;
  bookingId: string;
  userId: string;
  amount: number;
  reversedAt: Date | null;
}

class FakeCertsRepo {
  rows: GiftCertificate[] = [];
  spends: SpendRow[] = [];
  saved: GiftCertificate[] = [];
  /** следующий save падает коллизией уникального кода (один раз) */
  collideOnce = false;

  manager = {
    query: (sql: string, params: unknown[]) => this.query(sql, params),
  };

  async query(sql: string, params: unknown[]): Promise<unknown> {
    if (sql.includes("SET status = 'active'")) {
      // активация: условие purchased + живой срок — как в Postgres
      const found = this.rows.find(
        (r) =>
          r.code === params[0] &&
          r.status === 'purchased' &&
          r.expiresAt.getTime() > Date.now(),
      );
      if (!found) return [[], 0];
      found.status = 'active';
      found.activatedByUserId = params[1] as string;
      found.activatedAt = new Date();
      return [[{ id: found.id }], 1];
    }
    if (sql.includes('SELECT id, remaining_rub')) {
      const found = this.rows.find(
        (r) =>
          r.code === params[0] &&
          r.activatedByUserId === params[1] &&
          r.status === 'active' &&
          r.expiresAt.getTime() > Date.now(),
      );
      return found
        ? [{ id: found.id, remaining_rub: found.remainingRub }]
        : [];
    }
    if (sql.includes('remaining_rub = remaining_rub -')) {
      const found = this.rows.find((r) => r.id === params[0]);
      const amount = params[1] as number;
      if (!found || found.remainingRub < amount) return [[], 0];
      found.remainingRub -= amount;
      if (found.remainingRub === 0) found.status = 'exhausted';
      found.updatedAt = new Date();
      return [[{ id: found.id }], 1];
    }
    if (sql.includes('INSERT INTO gift_spends')) {
      this.spends.push({
        certificateId: params[0] as string,
        bookingId: params[1] as string,
        userId: params[2] as string,
        amount: params[3] as number,
        reversedAt: null,
      });
      return [{}, 1];
    }
    if (sql.includes('SET reversed_at = now()')) {
      // атомарный захват незаполненных трат брони
      const claimed = this.spends.filter(
        (s) => s.bookingId === params[0] && s.reversedAt === null,
      );
      for (const s of claimed) s.reversedAt = new Date();
      return [
        claimed.map((s) => ({
          certificate_id: s.certificateId,
          amount: s.amount,
        })),
        claimed.length,
      ];
    }
    if (sql.includes('remaining_rub = remaining_rub +')) {
      const found = this.rows.find((r) => r.id === params[0]);
      if (found) {
        found.remainingRub += params[1] as number;
        found.status = 'active';
        found.updatedAt = new Date();
      }
      return [{}, 1];
    }
    throw new Error(`unexpected query: ${sql}`);
  }

  create(partial: Partial<GiftCertificate>): GiftCertificate {
    return cert(partial);
  }

  /** все попытки save — и коллизионные тоже (ретрай виден по длине) */
  attempted: GiftCertificate[] = [];

  async save(row: GiftCertificate): Promise<GiftCertificate> {
    this.attempted.push(row);
    if (this.collideOnce) {
      this.collideOnce = false;
      const err = new Error('uq') as Error & {
        code: string;
        constraint: string;
      };
      err.code = '23505';
      err.constraint = 'uq_gift_certificates_code';
      throw err;
    }
    this.rows.push(row);
    this.saved.push(row);
    return row;
  }

  async find(): Promise<GiftCertificate[]> {
    return [...this.rows];
  }

  async findOneBy(where: { code?: string; id?: string }) {
    return (
      this.rows.find((r) => r.code === where.code || r.id === where.id) ??
      null
    );
  }

  async findOneByOrFail(where: { code?: string; id?: string }) {
    const found = await this.findOneBy(where);
    if (!found) throw new Error('не найден');
    return found;
  }
}

describe('GiftsService (юнит, фейк-репозиторий)', () => {
  let repo: FakeCertsRepo;
  let service: GiftsService;

  beforeEach(() => {
    repo = new FakeCertsRepo();
    service = new GiftsService(repo as never);
  });

  describe('покупка', () => {
    it('создаёт карту с номиналом, сроком и кодом', async () => {
      const dto = await service.purchase(USER, 1_500);

      expect(dto).toMatchObject({
        nominalRub: 1_500,
        remainingRub: 1_500,
        status: 'purchased',
      });
      expect(dto.code).toMatch(/^GIFT-[0-9A-HJKMNP-TV-Z]{8}$/);
      const row = repo.rows[0];
      expect(row.buyerUserId).toBe(USER.id);
      expect(
        row.expiresAt.getTime() - row.createdAt.getTime(),
      ).toBeGreaterThanOrEqual(364 * 86_400_000);
    });

    it('некруглый номинал — 400 без похода в БД', async () => {
      await expect(service.purchase(USER, 1_999)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.rows).toHaveLength(0);
    });

    it('коллизия кода — ретрай с новым кодом', async () => {
      repo.collideOnce = true;

      const dto = await service.purchase(USER, 500);

      // первая попытка упёрлась в uq, вторая прошла с другим кодом
      expect(repo.attempted).toHaveLength(2);
      expect(repo.saved).toHaveLength(1);
      expect(repo.attempted[0].code).not.toBe(dto.code);
    });
  });

  describe('активация', () => {
    it('победитель: карта становится active и привязывается к нему', async () => {
      repo.rows.push(cert());

      const dto = await service.activate(FRIEND, ' gift-ab2cd3ef ');

      expect(dto.status).toBe('active');
      expect(repo.rows[0].activatedByUserId).toBe(FRIEND.id);
      expect(repo.rows[0].activatedAt).not.toBeNull();
    });

    it('проигравший гонку — 409 giftAlreadyActivated', async () => {
      repo.rows.push(cert({ status: 'active', activatedByUserId: USER.id }));

      await expect(
        service.activate(FRIEND, 'GIFT-AB2CD3EF'),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'giftAlreadyActivated' },
      });
    });

    it('опечатка в коде — 404 giftNotFound', async () => {
      repo.rows.push(cert());

      await expect(
        service.activate(FRIEND, 'GIFT-NOPE1234'),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'giftNotFound' },
      });
    });
  });

  describe('витрина «мои»', () => {
    it('карты, подаренные коды и живой остаток', async () => {
      const mine = cert({
        id: 'c-mine',
        activatedByUserId: USER.id,
        status: 'active',
        remainingRub: 700,
      });
      const spent = cert({
        id: 'c-spent',
        code: 'GIFT-SPENT000',
        activatedByUserId: USER.id,
        status: 'exhausted',
        remainingRub: 0,
      });
      const given = cert({
        id: 'c-given',
        code: 'GIFT-GIVEN000',
        status: 'purchased',
      });
      const foreign = cert({
        id: 'c-foreign',
        code: 'GIFT-FOREIGN0',
        buyerUserId: 'stranger',
        activatedByUserId: 'stranger',
      });
      repo.rows.push(mine, spent, given, foreign);

      const dto = await service.my(USER);

      expect(dto.cards.map((c) => c.id)).toEqual(['c-mine', 'c-spent']);
      expect(dto.given.map((c) => c.id)).toEqual(['c-given']);
      // живой остаток — только непросроченные active-карты
      expect(dto.totals).toEqual({ availableRub: 700, cards: 2, given: 1 });
    });

    it('просроченная карта не попадает в доступный остаток', async () => {
      repo.rows.push(
        cert({
          activatedByUserId: USER.id,
          status: 'active',
          remainingRub: 900,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      );

      const dto = await service.my(USER);

      expect(dto.cards).toHaveLength(1);
      expect(dto.totals.availableRub).toBe(0);
    });
  });

  describe('списание в оплате', () => {
    it('списывает min(остаток карты, остаток чека) и пишет журнал', async () => {
      const row = cert({
        id: 'c-1',
        activatedByUserId: USER.id,
        status: 'active',
        remainingRub: 1_200,
      });
      repo.rows.push(row);

      const spent = await service.spendInTx(repo.manager as never, {
        code: 'GIFT-AB2CD3EF',
        userId: USER.id,
        bookingId: 'booking-1',
        restRub: 800,
      });

      expect(spent).toEqual({ code: 'GIFT-AB2CD3EF', amount: 800 });
      expect(row.remainingRub).toBe(400);
      expect(row.status).toBe('active');
      expect(repo.spends).toHaveLength(1);
      expect(repo.spends[0]).toMatchObject({
        certificateId: 'c-1',
        bookingId: 'booking-1',
        amount: 800,
      });
    });

    it('до нуля — карта exhausted', async () => {
      const row = cert({
        activatedByUserId: USER.id,
        status: 'active',
        remainingRub: 500,
      });
      repo.rows.push(row);

      await service.spendInTx(repo.manager as never, {
        code: 'GIFT-AB2CD3EF',
        userId: USER.id,
        bookingId: 'booking-1',
        restRub: 900,
      });

      expect(row.remainingRub).toBe(0);
      expect(row.status).toBe('exhausted');
    });

    it('чужая/неактивированная карта — GiftRefusedError', async () => {
      repo.rows.push(cert({ status: 'purchased' }));

      await expect(
        service.spendInTx(repo.manager as never, {
          code: 'GIFT-AB2CD3EF',
          userId: USER.id,
          bookingId: 'booking-1',
          restRub: 800,
        }),
      ).rejects.toBeInstanceOf(GiftRefusedError);
    });

    it('гонка: UPDATE не нашёл строк — GiftRefusedError', async () => {
      // карта с остатком в БД, но параллельная оплата успела списать:
      // SELECT видит старый остаток, UPDATE — пустой RETURNING
      repo.rows.push(
        cert({
          activatedByUserId: USER.id,
          status: 'active',
          remainingRub: 100,
        }),
      );
      const racedManager = {
        query: async (sql: string, params: unknown[]) => {
          if (sql.includes('remaining_rub = remaining_rub -')) return [[], 0];
          return repo.manager.query(sql, params);
        },
      };

      await expect(
        service.spendInTx(racedManager as never, {
          code: 'GIFT-AB2CD3EF',
          userId: USER.id,
          bookingId: 'booking-1',
          restRub: 800,
        }),
      ).rejects.toBeInstanceOf(GiftRefusedError);
    });
  });

  describe('возврат по брони', () => {
    it('возвращает сумму траты на карту и оживляет exhausted', async () => {
      const row = cert({
        id: 'c-1',
        activatedByUserId: USER.id,
        status: 'active',
        remainingRub: 300,
      });
      repo.rows.push(row);
      repo.spends.push({
        certificateId: 'c-1',
        bookingId: 'booking-1',
        userId: USER.id,
        amount: 500,
        reversedAt: null,
      });
      row.status = 'exhausted';
      row.remainingRub = 0;

      const returned = await service.reverseForBooking(
        repo.manager as never,
        'booking-1',
      );

      expect(returned).toBe(500);
      expect(row.remainingRub).toBe(500);
      expect(row.status).toBe('active');
      expect(repo.spends[0].reversedAt).not.toBeNull();
    });

    it('повторный возврат — ноль: траты уже помечены', async () => {
      repo.rows.push(
        cert({ id: 'c-1', activatedByUserId: USER.id, status: 'active' }),
      );
      repo.spends.push({
        certificateId: 'c-1',
        bookingId: 'booking-1',
        userId: USER.id,
        amount: 500,
        reversedAt: new Date(),
      });

      const returned = await service.reverseForBooking(
        repo.manager as never,
        'booking-1',
      );

      expect(returned).toBe(0);
    });

    it('бронь без гифт-трат — тихий ноль', async () => {
      const returned = await service.reverseForBooking(
        repo.manager as never,
        'booking-without-gift',
      );
      expect(returned).toBe(0);
    });
  });
});
