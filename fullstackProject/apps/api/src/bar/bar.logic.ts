import { BadRequestException } from '@nestjs/common';

/** порций одной позиции в заказе — потолок валидации (зеркалит DTO) */
export const MAX_QTY_PER_ITEM = 10;

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
