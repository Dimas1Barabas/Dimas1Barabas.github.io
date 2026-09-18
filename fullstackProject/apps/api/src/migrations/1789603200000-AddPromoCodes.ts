import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableUnique,
} from "typeorm";

/**
 * Промокоды: вид скидки (процент/фикс), лимит активаций, срок.
 *
 * Активация списывается атомарно в момент оплаты:
 * UPDATE promos SET used_count = used_count + 1
 *  WHERE code = $1 AND used_count < max_activations AND expires_at > now()
 * affected = 0 — код исчерпан/истёк в гонке за последний код, транзакция
 * оплаты откатывается целиком (бронь остаётся PENDING_PAYMENT).
 *
 * На брони запоминаем применённый код и скидку: total_rub после оплаты —
 * итоговая сумма, refund и аналитика подхватывают её без изменений.
 */
export class AddPromoCodes1789603200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "promos",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "code", type: "varchar", length: "32" },
          { name: "kind", type: "varchar", length: "8" },
          { name: "value", type: "int" },
          { name: "max_activations", type: "int" },
          { name: "used_count", type: "int", default: "0" },
          { name: "expires_at", type: "timestamptz" },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "updated_at", type: "timestamp", default: "now()" },
        ],
        uniques: [
          new TableUnique({ name: "uq_promos_code", columnNames: ["code"] }),
        ],
      }),
    );

    await queryRunner.addColumn(
      "bookings",
      new TableColumn({
        name: "promo_code",
        type: "varchar",
        length: "32",
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      "bookings",
      new TableColumn({ name: "discount_rub", type: "int", isNullable: true }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn("bookings", "discount_rub");
    await queryRunner.dropColumn("bookings", "promo_code");
    await queryRunner.dropTable("promos");
  }
}
