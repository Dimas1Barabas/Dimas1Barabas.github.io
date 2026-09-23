import {
  DefaultNamingStrategy,
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from "typeorm";

/**
 * Бонусная программа: bonus_transactions — ledger движений бонусов
 * (accrual/spend + причина). Баланс нигде не хранится, а считается от
 * источника: SUM(accrual) − SUM(spend) по user_id.
 *
 * uq (booking_id, reason) — идемпотентность: одна операция одного типа
 * по бронь; повторный INSERT (ределивери событий воркера) упирается в
 * констрейнт. bookings.bonus_spent — снимок «сколько бонусов вчёно в
 * оплату» (зеркало discount_rub у промокодов).
 */
export class AddBonusLedger1790121600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "bonus_transactions",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "user_id", type: "uuid" },
          { name: "booking_id", type: "uuid" },
          { name: "kind", type: "varchar", length: "16" },
          { name: "reason", type: "varchar", length: "16" },
          { name: "amount", type: "int" },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName(
              "bonus_transactions",
              ["user_id"],
              "users",
              ["id"],
            ),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
          new TableForeignKey({
            name: naming.foreignKeyName(
              "bonus_transactions",
              ["booking_id"],
              "bookings",
              ["id"],
            ),
            columnNames: ["booking_id"],
            referencedTableName: "bookings",
            referencedColumnNames: ["id"],
          }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("bonus_transactions", ["user_id"]),
            columnNames: ["user_id"],
          }),
        ],
        uniques: [
          new TableUnique({
            name: "uq_bonus_booking_reason",
            columnNames: ["booking_id", "reason"],
          }),
        ],
      }),
    );

    await queryRunner.addColumn(
      "bookings",
      new TableColumn({ name: "bonus_spent", type: "int", isNullable: true }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn("bookings", "bonus_spent");
    await queryRunner.dropTable("bonus_transactions");
  }
}
