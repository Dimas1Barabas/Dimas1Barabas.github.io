import { BadRequestException } from '@nestjs/common';
import { BarOrderStatus } from './bar-order.entity';

/** порций одной позиции в заказе — потолок валидации (зеркалит DTO) */
export const MAX_QTY_PER_ITEM = 10;

/**
 * Ранг статуса: жизненный цикл заказа монотонен NEW → PREPARING →
 * READY → PICKED_UP; CANCELLED — терминальный внеплановый. Ранги
 * сравнивает handleStatus: опоздавшее «готово» не оживит отменённый
 * заказ, ределивери того же статуса — пустой звук.
 */
const RANKS: Record<BarOrderStatus, number> = {
  NEW: 0,
  PREPARING: 1,
  READY: 2,
  PICKED_UP: 3,
  CANCELLED: 4,
};

export function statusRank(status: BarOrderStatus): number {
  return RANKS[status];
}

/**
 * Проверка строк заказа до транзакции: дубль itemId запрещён 400-м —
 * иначе одна позиция раскололась бы на две строки bar_order_items
 * и упёрлась в uq (order_id, item_id); количество правильнее указать
 * в qty. Границы qty/размер массива отсекает ValidationPipe по DTO,
 * здесь — второй рубеж на случай прямого вызова сервиса.
 */
export function validateBarOrder(
  items: { itemId: string; qty: number }[],
): void {
  const seen = new Set<string>();
  for (const line of items) {
    if (seen.has(line.itemId)) {
      throw new BadRequestException(
        'Позиция заказа продублирована — укажите количество в qty одной строкой',
      );
    }
    seen.add(line.itemId);
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY_PER_ITEM) {
      throw new BadRequestException(
        `Количество позиции должно быть целым от 1 до ${MAX_QTY_PER_ITEM}`,
      );
    }
  }
}

/** сумма заказа по позициям (снимки цен фиксируются при оформлении) */
export function barTotal(
  positions: { priceRub: number; qty: number }[],
): number {
  return positions.reduce((sum, p) => sum + p.priceRub * p.qty, 0);
}

/**
 * Скидка уровня «Киноман» (этап 38) на заказ бара: floor до целого
 * рубля — итог к оплате в целых, как и снимки цен. Процент ≤ 0 — без
 * пересчёта (Новичок); лестница ограничена 15%, перебора не бывает.
 * Позиции хранят полные снимки цен: barTotal(items) − скидка = total_rub.
 */
export function barDiscountRub(
  totalRub: number,
  discountPercent: number,
): number {
  if (discountPercent <= 0) return 0;
  return Math.floor((totalRub * discountPercent) / 100);
}

/** нехватка остатка: имя и сколько осталось — для честного 409 */
export class BarOutOfStockError extends Error {
  constructor(
    readonly itemName: string,
    readonly left: number,
  ) {
    super(`«${itemName}»: осталось ${left} порц.`);
    this.name = 'BarOutOfStockError';
  }
}
