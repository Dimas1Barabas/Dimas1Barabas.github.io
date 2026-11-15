import {
  MigrationInterface,
  QueryRunner,
  TableUnique,
} from "typeorm";

/**
 * Реферальная программа: по одной брони друга бонусы лежат двум счётам
 * — другу (cashback, referral_welcome) и пригласившему (referral).
 * Уника (booking_id, reason) это запрещала, расширяем тройкой
 * (booking_id, reason, user_id): идемпотентность ределивери сохраняется
 * — дубль одной и той же операции по-прежнему упирается в констрейнт.
 * Существующие данные новую унику не нарушают (была строже).
 */
export class WidenBonusUniqueForReferral1795132800000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropUniqueConstraint(
      "bonus_transactions",
      "uq_bonus_booking_reason",
    );
    await queryRunner.createUniqueConstraint(
      "bonus_transactions",
      new TableUnique({
        name: "uq_bonus_booking_reason_user",
        columnNames: ["booking_id", "reason", "user_id"],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropUniqueConstraint(
      "bonus_transactions",
      "uq_bonus_booking_reason_user",
    );
    await queryRunner.createUniqueConstraint(
      "bonus_transactions",
      new TableUnique({
        name: "uq_bonus_booking_reason",
        columnNames: ["booking_id", "reason"],
      }),
    );
  }
}
