import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Антифрод «Детектив» (этап 36): bookings.fraud_hold — бронь задержана
 * на ревью. Чекаут со скорингом review создаёт бронь с холдом и НЕ
 * запускает оплату: pay() честно отказывает 409 fraudReview, решение
 * принимает человек в админ-витрине (approve — системная оплата,
 * reject — отмена). Холд не продлевает окно резерва: не решили вовремя —
 * бронь истечёт обычным таймаутом, места вернутся в продажу.
 */
export class AddFraudHold1795564800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bookings
         ADD COLUMN IF NOT EXISTS fraud_hold boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE bookings DROP COLUMN IF EXISTS fraud_hold`,
    );
  }
}
