import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
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
  BAR_CANCELLABLE,
  toBarOrderDto,
} from './bar-order.entity';
import {
  BarOrderCancelledEvent,
  BarOrderCreatedEvent,
  BarOrderStatusEvent,
} from './bar-events';
import { BarOutOfStockError, barDiscountRub, barTotal, statusRank, validateBarOrder } from './bar.logic';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { CreateBarOrderDto } from './dto/create-bar-order.dto';

/** строка UPDATE … RETURNING атомарного списания; сам запрос у
 *  postgres-драйвера возвращает кортеж [строки, число затронутых] */
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
    @InjectRepository(BarOrder) private readonly orders: Repository<BarOrder>,
    @InjectRepository(BarOrderItem)
    private readonly orderItems: Repository<BarOrderItem>,
    private readonly dataSource: DataSource,
    private readonly outboxRelay: OutboxRelayClient,
    // скидка уровня «Киноман» (этап 38) на итог заказа
    private readonly loyalty: LoyaltyService,
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
          // postgres-драйвер TypeORM для UPDATE возвращает кортеж
          // [строки RETURNING, число затронутых] — даже при нуле строк
          // длина 2, пустоту видим по распакованным строкам (урок run 422:
          // чтение кортежа как массива строк отдавало undefined/NaN и
          // ронило INSERT заказа 500-м)
          const [rows] = await em.query<[DecrementRow[], number]>(
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

        // скидка уровня «Киноман» (этап 38): снимок перка на момент
        // оформления. Сбой чтения трат не отменяет заказ — деградация
        // в 0%, как tier 0 у квота при создании брони
        const discountPercent = await this.loyalty
          .barDiscountPercent(customer.id)
          .catch((err: unknown) => {
            this.logger.warn(
              `уровень ${customer.id} не прочитан — заказ бара без скидки: ${String(err)}`,
            );
            return 0;
          });
        const gross = barTotal(positions);
        const totalRub = gross - barDiscountRub(gross, discountPercent);

        const order = em.create(BarOrder, {
          id: randomUUID(), // нужен до сохранения — на него ссылаются позиции
          userId: customer.id,
          sessionId: session?.id ?? null,
          status: 'NEW',
          totalRub,
          loyaltyDiscountPercent: discountPercent,
        });
        const saved = await em.save(BarOrder, order);
        // relation для DTO (hall/sessionAt) — сеанс уже проверен выше
        saved.session = session;
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
          loyaltyDiscountPercent: saved.loyaltyDiscountPercent,
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

  /** «Мои заказы»: свежие сверху, с позициями и контекстом сеанса */
  async my(user: AuthUser): Promise<BarOrderDto[]> {
    const orders = await this.orders.find({
      where: { userId: user.id },
      relations: { items: true, session: true },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return orders.map((o) => toBarOrderDto(o, o.items ?? []));
  }

  /**
   * Отмена заказа: только владелец и только пока еду не выдали
   * (NEW/PREPARING). В той же транзакции порции возвращаются на склад,
   * Бармену уходит bar.order.cancelled — он молча убирает заказ из
   * очереди, ничего не готовя.
   */
  async cancel(orderId: string, user: AuthUser): Promise<BarOrderDto> {
    const result = await this.dataSource.transaction(async (em) => {
      const order = await em.findOneByOrFail(BarOrder, { id: orderId });
      if (order.userId !== user.id) {
        throw new ForbiddenException('Это не ваш заказ кинобара');
      }
      if (!BAR_CANCELLABLE.includes(order.status)) {
        throw new ConflictException(
          order.status === 'CANCELLED'
            ? 'Заказ уже отменён'
            : 'Заказ уже выдан — отменить нельзя',
        );
      }

      // порции возвращаются на склад: даже снятая с продажи позиция
      // копит остаток, вернётся на витрину вместе с active
      const lines = await em.find(BarOrderItem, { where: { orderId } });
      for (const line of lines) {
        await em.query(
          `UPDATE bar_items SET stock = stock + $1, updated_at = now()
           WHERE id = $2`,
          [line.qty, line.itemId],
        );
      }

      order.status = 'CANCELLED';
      const saved = await em.save(BarOrder, order);
      await enqueueOutbox(em, 'bar.order.cancelled', {
        orderId: saved.id,
        cancelledAt: new Date().toISOString(),
      } satisfies BarOrderCancelledEvent);
      return saved.id;
    });

    this.outboxRelay.poke();
    this.logger.log(`Заказ кинобара ${result} отменён, порции вернулись на склад`);
    return this.orderWithItems(result);
  }

  /** заказ с позициями и контекстом сеанса — форма ответа my/cancel */
  private async orderWithItems(orderId: string): Promise<BarOrderDto> {
    const order = await this.orders.findOneOrFail({
      where: { id: orderId },
      relations: { items: true, session: true },
    });
    return toBarOrderDto(order, order.items ?? []);
  }

  /**
   * Статусный переход от Бармена (bar.order.status): PREPARING / READY /
   * PICKED_UP. Монотонность бережёт от гонки с отменой — если владелец
   * уже отменил заказ (остатки вернулись), опоздавшее «готово» его не
   * оживит; повторный ределивери того же статуса тоже пропускается.
   */
  async handleStatus(event: BarOrderStatusEvent): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      let order: BarOrder;
      try {
        order = await em.findOneByOrFail(BarOrder, { id: event.orderId });
      } catch {
        // заказа нет (например, БД пересобрана) — poison'ом не считаем,
        // ack: событие больше некому ждать
        this.logger.warn(
          `Статус ${event.status} для неизвестного заказа ${event.orderId} — пропущен`,
        );
        return;
      }
      if (statusRank(event.status) <= statusRank(order.status)) {
        this.logger.log(
          `Статус ${event.status} заказа ${event.orderId} не новее текущего ` +
            `${order.status} — пропущен (гонка с отменой или ределивери)`,
        );
        return;
      }
      order.status = event.status;
      await em.save(BarOrder, order);
      this.logger.log(
        `Заказ кинобара ${event.orderId}: ${event.status} ` +
          `(Бармен, ${event.customerName})`,
      );
    });
  }
}
