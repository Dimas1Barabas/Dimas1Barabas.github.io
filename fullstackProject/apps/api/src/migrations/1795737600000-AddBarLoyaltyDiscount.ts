import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Скидка уровня «Киноман» в заказе бара (этап 38). Процент — снимок
 * перка на момент оформления: позиции хранят полные снимки цен, поэтому
 * barTotal(items) − скидка = total_rub, аудит пересчитываем. Уровень
 * живёт в тратах броней (ledger), здесь — только факт применённого
 * перка; 0 — Новичок (до этапа 38 все заказы были «нулевыми»).
 */
export class AddBarLoyaltyDiscount1795737600000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bar_orders
         ADD COLUMN loyalty_discount_percent integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bar_orders DROP COLUMN loyalty_discount_percent`,
    );
  }
}
