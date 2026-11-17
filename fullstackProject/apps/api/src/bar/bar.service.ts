import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { enqueueOutbox } from '../outbox/outbox';
import { OutboxRelayClient } from '../outbox/outbox-relay.client';
import { Session } from '../movies/session.entity';
import { User } from '../users/user.entity';
import { BAR_CATALOG, categoryRank } from './bar-catalog';
import { BarItem, BarItemDto, toBarItemDto } from './bar-item.entity';
import {
  BarOrder,
  BarOrderItem,
  BarOrderDto,
  toBarOrderDto,
} from './bar-order.entity';
import { BarOrderCreatedEvent } from './bar-events';
import { BarOutOfStockError, barTotal, validateBarOrder } from './bar.logic';
import { CreateBarOrderDto } from './dto/create-bar-order.dto';

/** строка UPDATE … RETURNING атомарного списания */
type DecrementRow = { name: string; price_rub: number | string };

/**
 * Кинобар: каталог с остатками и заказы. Посев каталога — как у фильмов,
 * в пустую таблицу при старте. Списание остатка — атомарный условный
 * UPDATE в транзакции заказа (create), отмена возвращает порции.
 */
@Injectable()
export class BarService implements OnModuleInit {
  private readonly logger = new Logger(BarService.name);

  constructor(
    @InjectRepository(BarItem) private readonly items: Repository<BarItem>,
    private readonly dataSource: DataSource,
    private readonly outboxRelay: OutboxRelayClient,
  ) {}

  /** посев каталога в пустую таблицу (миграции создают схему раньше) */
  async onModuleInit(): Promise<void> {
    const count = await this.items.count();
    if (count > 0) return;
    await this.items.save(
      BAR_CATALOG.map((s) => this.items.create(s)),
    );
    this.logger.log(
      `Посеял каталог кинобара: ${BAR_CATALOG.length} позиций ` +
        `(${BAR_CATALOG.reduce((s, i) => s + i.stock, 0)} порций на складе)`,
    );
  }

  /** витрина каталога: только active, категории по порядку витрины */
  async menu(): Promise<BarItemDto[]> {
    const rows = await this.items.find({ where: { active: true } });
    return rows
      .sort(
        (a, b) =>
          categoryRank(a.category) - categoryRank(b.category) ||
          a.name.localeCompare(b.name, 'ru'),
      )
      .map(toBarItemDto);
  }

  /**
   * Оформить предзаказ: одна транзакция — атомарное списание каждой
   * позиции, заказ со снимками цен и outbox-событие Бармену.
   *
   * Гонка за последнюю порцию решает СУБД: UPDATE bar_items
   * SET stock = stock - qty WHERE id AND active AND stock >= qty
   * блокирует строку до COMMIT первой транзакции, конкурент ждёт
   * блокировки и перечитывает WHERE — второму достаётся 0 строк,
   * транзакция откатывается целиком (включая уже списанные позиции),
   * юзер видит 409 с честным остатком. Отрицательный stock невозможен.
   */
  async create(dto: CreateBarOrderDto, user: AuthUser): Promise<BarOrderDto> {
    validateBarOrder(dto.items);

    try {
      const result = await this.dataSource.transaction(async (em) => {
        // подсказка «выдать к сеансу»: сеанс должен существовать
        let session: Session | null = null;
        if (dto.sessionId) {
          session = await em.findOneByOrFail(Session, { id: dto.sessionId });
        }
        const customer = await em.findOneByOrFail(User, { id: user.id });

        // атомарное списание порций — по одной строке каталога за раз
        const positions: {
          itemId: string;
          name: string;
          priceRub: number;
          qty: number;
        }[] = [];
        for (const line of dto.items) {
          const rows: DecrementRow[] = await em.query(
            `UPDATE bar_items
               SET stock = stock - $1, updated_at = now()
             WHERE id = $2 AND active AND stock >= $1
             RETURNING name, price_rub`,
            [line.qty, line.itemId],
          );
          if (rows.length === 0) {
            // позиция неактивна или остатка не хватило: говорим честно,
            // сколько есть (строка существует — иначе 404 от findOneByOrFail)
            const item = await em.findOneByOrFail(BarItem, {
              id: line.itemId,
            });
            throw new BarOutOfStockError(item.name, item.stock);
          }
          positions.push({
            itemId: line.itemId,
            name: rows[0].name,
            priceRub: Number(rows[0].price_rub),
            qty: line.qty,
          });
        }

        const order = em.create(BarOrder, {
          id: randomUUID(), // нужен до сохранения — на него ссылаются позиции
          userId: customer.id,
          sessionId: session?.id ?? null,
          status: 'NEW',
          totalRub: barTotal(positions),
        });
        const saved = await em.save(BarOrder, order);
        await em.insert(
          BarOrderItem,
          positions.map((p) => ({
            orderId: order.id,
            itemId: p.itemId,
            name: p.name,
            priceRub: p.priceRub,
            qty: p.qty,
          })),
        );

        const event: BarOrderCreatedEvent = {
          orderId: order.id,
          userId: customer.id,
          customerName: customer.name,
          email: customer.email,
          sessionId: session?.id ?? null,
          sessionAt: session?.startsAt?.toISOString() ?? null,
          hall: session?.hall ?? null,
          items: positions.map(({ itemId, name, priceRub, qty }) => ({
            itemId,
            name,
            priceRub,
            qty,
          })),
          totalRub: saved.totalRub,
          createdAt: saved.createdAt.toISOString(),
        };
        await enqueueOutbox(em, 'bar.order.created', event);

        return { order: saved, positions };
      });

      // коммит с outbox-записью прошёл — будим Курьера, не дожидаясь тика
      this.outboxRelay.poke();
      this.logger.log(
        `Заказ кинобара ${result.order.id} (${result.positions
          .map((p) => `${p.name}×${p.qty}`)
          .join(', ')}, ${result.order.totalRub} ₽) оформлен пользователем ` +
          `${user.email}${dto.sessionId ? `, к сеансу ${dto.sessionId}` : ''}`,
      );
      return toBarOrderDto(result.order, result.positions);
    } catch (err) {
      if (err instanceof BarOutOfStockError) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: err.message,
        });
      }
      throw err;
    }
  }
}
