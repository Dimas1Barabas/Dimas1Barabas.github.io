import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityNotFoundError } from 'typeorm';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { TypeOrmNotFoundFilter } from '../src/exceptions/typeorm-not-found.filter';
import { BarItem } from '../src/bar/bar-item.entity';
import { BarOrder, BarOrderItem } from '../src/bar/bar-order.entity';
import { BarController } from '../src/bar/bar.controller';
import { BarService } from '../src/bar/bar.service';
import { LoyaltyService } from '../src/loyalty/loyalty.service';
import { OutboxMessage } from '../src/outbox/outbox-message.entity';
import { OutboxRelayClient } from '../src/outbox/outbox-relay.client';
import { Session } from '../src/movies/session.entity';
import { User } from '../src/users/user.entity';

/**
 * Интеграционный тест кинобара: реальный HTTP-стек Nest (роутинг,
 * ValidationPipe, JWT-гвард → контроллер → сервис) на in-memory фейках
 * каталога/заказов. em.query эмулирует атомарный UPDATE … WHERE
 * stock >= qty RETURNING условием по строке — в формате драйвера,
 * кортежем [rows, affected]: фейк, отдающий голый массив строк, не
 * ловит неверную распаковку в сервисе. Гонка за последнюю порцию
 * воспроизводится последовательными заказами: второму строка не
 * отдаётся, транзакция (со snapshot-откатом, как в int-harness)
 * возвращает всё списанное.
 */

/** фейк каталога: find по active, count для посева, save-вставки */
class FakeBarItemRepo {
  rows: BarItem[] = [];
  async count(): Promise<number> {
    return this.rows.length;
  }
  async find(opts?: { where?: { active?: boolean } }): Promise<BarItem[]> {
    let rows = [...this.rows];
    if (opts?.where?.active !== undefined) {
      rows = rows.filter((r) => r.active === opts.where!.active);
    }
    return rows;
  }
  create(x: Partial<BarItem>): BarItem {
    return {
      id: randomUUID(),
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...x,
    } as BarItem;
  }
  async save(list: BarItem[]): Promise<BarItem[]> {
    for (const x of list) if (!this.rows.includes(x)) this.rows.push(x);
    return list;
  }
  async findOneByOrFail(where: { id: string }): Promise<BarItem> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new EntityNotFoundError(BarItem, where);
    return found;
  }
}

/** фейк заказов: свежие сверху, relations эмулируются прямым полем */
class FakeBarOrderRepo {
  rows: BarOrder[] = [];
  create(x: Partial<BarOrder>): BarOrder {
    return x as BarOrder;
  }
  async save(o: BarOrder): Promise<BarOrder> {
    if (!o.createdAt) o.createdAt = new Date();
    o.updatedAt = new Date();
    if (!this.rows.includes(o)) this.rows.unshift(o);
    return o;
  }
  async find(opts: { where: { userId: string } }): Promise<BarOrder[]> {
    return this.rows.filter((r) => r.userId === opts.where.userId);
  }
  async findOneOrFail(opts: { where: { id: string } }): Promise<BarOrder> {
    const found = this.rows.find((r) => r.id === opts.where.id);
    if (!found) throw new EntityNotFoundError(BarOrder, opts.where);
    return found;
  }
}

/** фейк позиций заказа: строки с orderId */
class FakeBarOrderItemRepo {
  rows: BarOrderItem[] = [];
  async find(opts: { where: { orderId: string } }): Promise<BarOrderItem[]> {
    return this.rows.filter((r) => r.orderId === opts.where.orderId);
  }
  async insert(list: Partial<BarOrderItem>[]): Promise<void> {
    this.rows.push(
      ...list.map(
        (r) => ({ id: randomUUID(), createdAt: new Date(), ...r }) as BarOrderItem,
      ),
    );
  }
}

/** id каталога — валидные UUID: DTO заказа проверяет @IsUUID() */
const ITEM = {
  popcorn: '00000000-0000-4000-8000-0000000000a1',
  cola: '00000000-0000-4000-8000-0000000000a2',
  water: '00000000-0000-4000-8000-0000000000a3',
  combo: '00000000-0000-4000-8000-0000000000a4',
  retired: '00000000-0000-4000-8000-0000000000a5',
};

/** каталог стенда: вода с дефицитом — героиня гонок */
function seedCatalog(items: FakeBarItemRepo): void {
  items.rows = [
    { id: ITEM.popcorn, slug: 'popcorn-salted', name: 'Попкорн солёный', category: 'popcorn', priceRub: 320, stock: 40, active: true } as BarItem,
    { id: ITEM.cola, slug: 'cola-05', name: 'Кола 0,5 л', category: 'drinks', priceRub: 220, stock: 30, active: true } as BarItem,
    { id: ITEM.water, slug: 'water-sparkling', name: 'Вода газированная 0,5 л', category: 'drinks', priceRub: 150, stock: 3, active: true } as BarItem,
    { id: ITEM.combo, slug: 'combo-classic', name: 'Комбо: попкорн солёный + кола 0,5', category: 'combo', priceRub: 490, stock: 5, active: true } as BarItem,
    { id: ITEM.retired, slug: 'nachos-old', name: 'Начос (старое меню)', category: 'snacks', priceRub: 380, stock: 99, active: false } as BarItem,
  ];
}

describe('Кинобар: HTTP-интеграция каталога и заказов', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let itemsRepo: FakeBarItemRepo;
  let ordersRepo: FakeBarOrderRepo;
  let orderItemsRepo: FakeBarOrderItemRepo;
  let outboxRows: { routingKey: string; payload: object }[];
  let bearer: string;
  let bearerB: string;
  let sessionId: string;
  let sessions: { [id: string]: Session };
  let users: { [id: string]: User };
  /** скидка уровня «Киномана» юзера-а: кейсы переключают точечно */
  let loyaltyPercent = 0;

  const line = (itemId: string, qty: number) => ({ itemId, qty });

  beforeAll(async () => {
    itemsRepo = new FakeBarItemRepo();
    ordersRepo = new FakeBarOrderRepo();
    orderItemsRepo = new FakeBarOrderItemRepo();
    outboxRows = [];

    sessionId = randomUUID();
    const startsAt = new Date('2026-11-20T19:30:00Z');
    sessions = {
      [sessionId]: { id: sessionId, hall: 'IMAX', startsAt } as Session,
    };
    const userA: User = {
      id: 'user-a',
      email: 'anna@test.local',
      name: 'Анна',
      role: 'user',
    } as User;
    const userB: User = {
      id: 'user-b',
      email: 'boris@test.local',
      name: 'Борис',
      role: 'user',
    } as User;
    users = { [userA.id]: userA, [userB.id]: userB };

    // эмуляция EntityManager: атомарный декремент — условие по строке,
    // RETURNING отдаёт имя/цену; инкремент возврата — безусловный
    const em = {
      findOneByOrFail: (entity: unknown, where: { id: string }) => {
        if (entity === Session) {
          const s = sessions[where.id];
          if (!s) throw new EntityNotFoundError(Session, where);
          return s;
        }
        if (entity === User) {
          const u = users[where.id];
          if (!u) throw new EntityNotFoundError(User, where);
          return u;
        }
        if (entity === BarItem) return itemsRepo.findOneByOrFail(where);
        if (entity === BarOrder) {
          const o = ordersRepo.rows.find((r) => r.id === where.id);
          if (!o) throw new EntityNotFoundError(BarOrder, where);
          return o;
        }
        throw new Error(`unexpected entity ${String(entity)}`);
      },
      find: (entity: unknown, opts: { where: { orderId: string } }) => {
        if (entity === BarOrderItem) return orderItemsRepo.find(opts);
        throw new Error(`unexpected entity ${String(entity)}`);
      },
      create: (entity: unknown, x: Partial<BarOrder>) => x,
      save: async (entity: unknown, x: BarOrder) => {
        if (entity === BarOrder) return ordersRepo.save(x);
        throw new Error('unexpected save');
      },
      insert: (entity: unknown, list: Partial<BarOrderItem>[]) => {
        if (entity === BarOrderItem) return orderItemsRepo.insert(list);
        throw new Error(`unexpected insert ${String(entity)}`);
      },
      query: jest.fn(async (sql: string, params: unknown[]) => {
        // формат PostgresQueryRunner: UPDATE возвращает кортеж
        // [rows, affected] (даже при нуле строк длина 2) — фейк с голым
        // массивом строк прятал граблю распаковки (run 422, e2e 500)
        if (sql.includes('stock = stock -')) {
          const [qty, id] = params as [number, string];
          const item = itemsRepo.rows.find((r) => r.id === id);
          if (!item || !item.active || item.stock < qty) return [[], 0];
          item.stock -= qty;
          return [[{ name: item.name, price_rub: item.priceRub }], 1];
        }
        if (sql.includes('stock = stock +')) {
          const [qty, id] = params as [number, string];
          const item = itemsRepo.rows.find((r) => r.id === id);
          if (item) item.stock += qty;
          return [[], item ? 1 : 0];
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      getRepository: (entity: unknown) => {
        if (entity !== OutboxMessage) {
          throw new Error(`unexpected entity: ${String(entity)}`);
        }
        return {
          insert: async (row: { routingKey: string; payload: object }) => {
            outboxRows.push(row);
          },
        };
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [BarController],
      providers: [
        BarService,
        { provide: getRepositoryToken(BarItem), useValue: itemsRepo },
        { provide: getRepositoryToken(BarOrder), useValue: ordersRepo },
        { provide: getRepositoryToken(BarOrderItem), useValue: orderItemsRepo },
        { provide: OutboxRelayClient, useValue: { poke: jest.fn() } },
        // уровень «Киномана» (этап 38): по умолчанию Новичок — 0%
        {
          provide: LoyaltyService,
          useValue: {
            barDiscountPercent: jest.fn(async () => loyaltyPercent),
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: async (cb: (e: typeof em) => unknown) => {
              // снимки для отката — как живой PG: исключение возвращает
              // и списанные порции, и заказы, и outbox
              const itemsSnap = itemsRepo.rows.map((r) => ({ ...r }));
              const ordersSnap = ordersRepo.rows.map((r) => ({ ...r }));
              const orderItemsSnap = orderItemsRepo.rows.map((r) => ({ ...r }));
              const outboxSnap = outboxRows.map((r) => ({ ...r }));
              try {
                return await cb(em);
              } catch (err) {
                itemsRepo.rows.splice(0, itemsRepo.rows.length, ...(itemsSnap as BarItem[]));
                ordersRepo.rows.splice(0, ordersRepo.rows.length, ...(ordersSnap as BarOrder[]));
                orderItemsRepo.rows.splice(0, orderItemsRepo.rows.length, ...(orderItemsSnap as BarOrderItem[]));
                outboxRows.splice(0, outboxRows.length, ...outboxSnap);
                throw err;
              }
            },
          },
        },
        { provide: ConfigService, useValue: { get: (_k: string, def?: string) => def } },
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        // findOneByOrFail по несуществующему id → 404, не 500 (как в AppModule)
        { provide: APP_FILTER, useClass: TypeOrmNotFoundFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init(); // onModuleInit — посев, но стенд сеет каталог сам

    const jwt = moduleRef.get(JwtService);
    const sign = (sub: string, name: string) =>
      jwt.signAsync({ sub, email: `${sub}@test.local`, name, role: 'user' });
    bearer = `Bearer ${await sign('user-a', 'Анна Тест')}`;
    bearerB = `Bearer ${await sign('user-b', 'Борис Чужой')}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    seedCatalog(itemsRepo);
    ordersRepo.rows = [];
    orderItemsRepo.rows = [];
    outboxRows.length = 0;
    loyaltyPercent = 0;
  });

  it('витрина меню публична: активные позиции по порядку категорий, снятых нет', async () => {
    const res = await request(app.getHttpServer()).get('/api/bar/menu');
    expect(res.status).toBe(200);
    expect(res.body.map((i: { slug: string }) => i.slug)).toEqual([
      'popcorn-salted',
      'water-sparkling', // внутри категории — по алфавиту (ru): «Вода» < «Кола»
      'cola-05',
      'combo-classic',
    ]);
    const water = res.body.find(
      (i: { slug: string }) => i.slug === 'water-sparkling',
    );
    expect(water).toMatchObject({ stock: 3, soldOut: false });
  });

  it('заказ без JWT — 401 (меню при этом публично)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .send({ items: [line(ITEM.popcorn, 1)] });
    expect(res.status).toBe(401);
  });

  it('оформление: 201, NEW, снимки цен, сумма и outbox-событие Бармену', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.popcorn, 2), line(ITEM.cola, 1)], sessionId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'NEW',
      totalRub: 320 * 2 + 220,
      hall: 'IMAX',
      sessionAt: '2026-11-20T19:30:00.000Z',
    });
    expect(res.body.items).toEqual([
      { itemId: ITEM.popcorn, name: 'Попкорн солёный', priceRub: 320, qty: 2 },
      { itemId: ITEM.cola, name: 'Кола 0,5 л', priceRub: 220, qty: 1 },
    ]);
    // остатки списаны
    expect(itemsRepo.rows.find((r) => r.id === ITEM.popcorn)!.stock).toBe(38);
    // событие в outbox с адресатом «письма» и подсказкой сеанса
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].routingKey).toBe('bar.order.created');
    expect(outboxRows[0].payload).toMatchObject({
      customerName: 'Анна',
      email: 'anna@test.local',
      hall: 'IMAX',
      totalRub: 860,
    });
  });

  it('Киноман (10%): итог со скидкой, процент — снимок в заказе и событии', async () => {
    loyaltyPercent = 10;
    const res = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.popcorn, 2), line(ITEM.cola, 1)] }); // 860
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      totalRub: 774, // 860 − 10% (floor до рубля)
      loyaltyDiscountPercent: 10,
    });
    // позиции — полные снимки цен: барTotal(items) − скидка = итог
    expect(res.body.items).toEqual([
      { itemId: ITEM.popcorn, name: 'Попкорн солёный', priceRub: 320, qty: 2 },
      { itemId: ITEM.cola, name: 'Кола 0,5 л', priceRub: 220, qty: 1 },
    ]);
    // Бармену едет итог к оплате и применённый процент
    expect(outboxRows[0].payload).toMatchObject({
      totalRub: 774,
      loyaltyDiscountPercent: 10,
    });
  });

  it('заказ без сеанса — sessionAt/hall null, Бармен выдаст на стойке', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.cola, 1)] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sessionId: null, hall: null, sessionAt: null });
  });

  it('несуществующий сеанс — 404, ничего не списано', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.cola, 1)], sessionId: randomUUID() });
    expect(res.status).toBe(404);
    expect(itemsRepo.rows.find((r) => r.id === ITEM.cola)!.stock).toBe(30);
    expect(outboxRows).toHaveLength(0);
  });

  it('нехватка остатка — 409 с честным остатком, транзакция откатывает всё', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.cola, 5), line(ITEM.water, 5)] }); // воды только 3
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Вода газированная 0,5 л');
    expect(res.body.message).toContain('осталось 3 порц.');
    // кола, списанная до воды, вернулась — откат транзакции целиком
    expect(itemsRepo.rows.find((r) => r.id === ITEM.cola)!.stock).toBe(30);
    expect(ordersRepo.rows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });

  it('гонка за последнюю порцию: первый забрал, второму 409', async () => {
    // воды 3: первый берёт 2 — остаётся 1
    const first = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.water, 2)] });
    expect(first.status).toBe(201);
    // второму нужно 2 — а строка отдаёт максимум 1
    const second = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearerB)
      .send({ items: [line(ITEM.water, 2)] });
    expect(second.status).toBe(409);
    expect(itemsRepo.rows.find((r) => r.id === ITEM.water)!.stock).toBe(1);
  });

  it('неактивная позиция — 409: снята с продажи, остаток не важен', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.retired, 1)] });
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('Начос (старое меню)');
  });

  it('валидация: дубль позиции и пустая корзина — 400', async () => {
    const dup = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.cola, 1), line(ITEM.cola, 2)] });
    expect(dup.status).toBe(400);

    const empty = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [] });
    expect(empty.status).toBe(400);
  });

  it('отмена: NEW → CANCELLED, порции вернулись, событие Бармену', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.combo, 3)] }); // 5 − 3 = 2
    expect(created.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post(`/api/bar/orders/${created.body.id}/cancel`)
      .set('Authorization', bearer);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CANCELLED');
    // порции на складе снова
    expect(itemsRepo.rows.find((r) => r.id === ITEM.combo)!.stock).toBe(5);
    expect(outboxRows.map((r) => r.routingKey)).toEqual([
      'bar.order.created',
      'bar.order.cancelled',
    ]);
  });

  it('отмена выданного — 409, повторная отмена — 409, чужой заказ — 403', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.cola, 1)] });
    const id = created.body.id;

    // чужой не отменяет
    const alien = await request(app.getHttpServer())
      .post(`/api/bar/orders/${id}/cancel`)
      .set('Authorization', bearerB);
    expect(alien.status).toBe(403);

    // выданный (статус сменил Бармен) — не отменяется
    ordersRepo.rows.find((r) => r.id === id)!.status = 'PICKED_UP';
    const served = await request(app.getHttpServer())
      .post(`/api/bar/orders/${id}/cancel`)
      .set('Authorization', bearer);
    expect(served.status).toBe(409);
    expect(served.body.message).toContain('уже выдан');

    // отменённый повторно — тоже 409
    ordersRepo.rows.find((r) => r.id === id)!.status = 'CANCELLED';
    const again = await request(app.getHttpServer())
      .post(`/api/bar/orders/${id}/cancel`)
      .set('Authorization', bearer);
    expect(again.status).toBe(409);
    expect(again.body.message).toContain('уже отменён');
  });

  it('статусы Бармена монотонны: опоздавшее «готово» не оживит отмену', async () => {
    const barService = app.get(BarService);
    const created = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.popcorn, 1)] });
    const id = created.body.id;

    // PREPARING — применяется
    await barService.handleStatus({
      orderId: id,
      status: 'PREPARING',
      email: 'anna@test.local',
      customerName: 'Анна',
      changedAt: new Date().toISOString(),
    });
    // ределивери того же статуса — пропускается (ранг не вырос);
    // «даунгрейд» ниже NEW контрактом исключён: Бармен NEW не шлёт
    await barService.handleStatus({
      orderId: id,
      status: 'PREPARING',
      email: 'anna@test.local',
      customerName: 'Анна',
      changedAt: new Date().toISOString(),
    });
    let res = await request(app.getHttpServer())
      .get('/api/bar/orders/my')
      .set('Authorization', bearer);
    expect(res.body[0].status).toBe('PREPARING');

    // владелец отменил — терминальный статус
    await request(app.getHttpServer())
      .post(`/api/bar/orders/${id}/cancel`)
      .set('Authorization', bearer);

    // опоздавшее READY из очереди Бармена отмену не перебьёт
    await barService.handleStatus({
      orderId: id,
      status: 'READY',
      email: 'anna@test.local',
      customerName: 'Анна',
      changedAt: new Date().toISOString(),
    });
    res = await request(app.getHttpServer())
      .get('/api/bar/orders/my')
      .set('Authorization', bearer);
    expect(res.body[0].status).toBe('CANCELLED');

    // неизвестный заказ — не poison: тихий ack
    await expect(
      barService.handleStatus({
        orderId: '00000000-0000-4000-8000-00000000dead',
        status: 'READY',
        email: 'x@test.local',
        customerName: 'Никто',
        changedAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it('мои заказы: только свои, свежие сверху, с составом', async () => {
    await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.cola, 1)] });
    await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearerB)
      .send({ items: [line(ITEM.popcorn, 1)] });
    const mine = await request(app.getHttpServer())
      .post('/api/bar/orders')
      .set('Authorization', bearer)
      .send({ items: [line(ITEM.water, 1)] });

    const res = await request(app.getHttpServer())
      .get('/api/bar/orders/my')
      .set('Authorization', bearer);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe(mine.body.id); // свежие сверху
    // заказ Бориса не виден
    const alienId = ordersRepo.rows.find((r) => r.userId === 'user-b')!.id;
    expect(res.body.every((o: { id: string }) => o.id !== alienId)).toBe(true);
  });
});
