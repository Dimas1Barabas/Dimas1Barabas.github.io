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
 * Гифт-сертификаты (этап 33): подарочные карты кинотеатра.
 *
 * gift_certificates — карта: покупатель платит номинал (оплата на кассе
 * сайта, деньги симулируются как везде в проекте), получатель активирует
 * код один раз (purchased → active) и тратит частями. Списание
 * атомарное: UPDATE … SET remaining_rub = remaining_rub − :amount WHERE
 * remaining_rub >= :amount — гонку за последний рубль решает БД, как у
 * промокодов и остатков кинобара. expires_at закрывает и активацию, и
 * трату; exhausted — remaining = 0 (хранится явно для витрины: возврат
 * отменённой брони оживляет карту обратно в active).
 *
 * gift_spends — журнал трат: строка на применение карты к брони,
 * uq (certificate_id, booking_id) не даёт задвоить применение.
 * reversed_at помечает возврат (отмена брони / провал оплаты): деньги
 * возвращаются на карту ровно один раз — повторный вердикт видит
 * помеченную строку и ничего не делает.
 *
 * bookings.gift_code / gift_spent — след применения карты, как
 * promo_code / discount_rub / bonus_spent: вердикт, письмо и витрина
 * читают факт оплаты из строки брони.
 */
export class AddGiftCertificates1795392000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "gift_certificates",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "code", type: "varchar", length: "16" },
          { name: "nominal_rub", type: "integer" },
          { name: "remaining_rub", type: "integer" },
          { name: "status", type: "varchar", length: "12", default: "'purchased'" },
          { name: "buyer_user_id", type: "uuid" },
          { name: "activated_by_user_id", type: "uuid", isNullable: true },
          { name: "activated_at", type: "timestamptz", isNullable: true },
          { name: "expires_at", type: "timestamptz" },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "updated_at", type: "timestamp", default: "now()" },
        ],
        uniques: [
          new TableUnique({
            name: "uq_gift_certificates_code",
            columnNames: ["code"],
          }),
        ],
      }),
    );

    // витрина «Мои сертификаты»: купленные и активированные
    await queryRunner.createIndex(
      "gift_certificates",
      new TableIndex({
        name: naming.indexName("gift_certificates", ["buyer_user_id"]),
        columnNames: ["buyer_user_id"],
      }),
    );
    await queryRunner.createIndex(
      "gift_certificates",
      new TableIndex({
        name: naming.indexName("gift_certificates", ["activated_by_user_id"]),
        columnNames: ["activated_by_user_id"],
      }),
    );

    await queryRunner.createForeignKey(
      "gift_certificates",
      new TableForeignKey({
        name: naming.foreignKeyName(
          "gift_certificates",
          ["buyer_user_id"],
          "users",
          ["id"],
        ),
        columnNames: ["buyer_user_id"],
        referencedTableName: "users",
        referencedColumnNames: ["id"],
      }),
    );
    await queryRunner.createForeignKey(
      "gift_certificates",
      new TableForeignKey({
        name: naming.foreignKeyName(
          "gift_certificates",
          ["activated_by_user_id"],
          "users",
          ["id"],
        ),
        columnNames: ["activated_by_user_id"],
        referencedTableName: "users",
        referencedColumnNames: ["id"],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "gift_spends",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "certificate_id", type: "uuid" },
          { name: "booking_id", type: "uuid" },
          { name: "user_id", type: "uuid" },
          { name: "amount", type: "integer" },
          { name: "reversed_at", type: "timestamptz", isNullable: true },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
        uniques: [
          new TableUnique({
            name: "uq_gift_spends_certificate_booking",
            columnNames: ["certificate_id", "booking_id"],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName(
              "gift_spends",
              ["certificate_id"],
              "gift_certificates",
              ["id"],
            ),
            columnNames: ["certificate_id"],
            referencedTableName: "gift_certificates",
            referencedColumnNames: ["id"],
          }),
          new TableForeignKey({
            name: naming.foreignKeyName(
              "gift_spends",
              ["booking_id"],
              "bookings",
              ["id"],
            ),
            columnNames: ["booking_id"],
            referencedTableName: "bookings",
            referencedColumnNames: ["id"],
          }),
          new TableForeignKey({
            name: naming.foreignKeyName("gift_spends", ["user_id"], "users", ["id"]),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
        ],
      }),
    );

    // возврат по брони: журнал трат ищется бронью
    await queryRunner.createIndex(
      "gift_spends",
      new TableIndex({
        name: naming.indexName("gift_spends", ["booking_id"]),
        columnNames: ["booking_id"],
      }),
    );

    await queryRunner.addColumn(
      "bookings",
      new TableColumn({ name: "gift_code", type: "varchar", length: "16", isNullable: true }),
    );
    await queryRunner.addColumn(
      "bookings",
      new TableColumn({ name: "gift_spent", type: "integer", isNullable: true }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.dropColumn("bookings", "gift_spent");
    await queryRunner.dropColumn("bookings", "gift_code");

    await queryRunner.dropIndex(
      "gift_spends",
      naming.indexName("gift_spends", ["booking_id"]),
    );
    await queryRunner.dropTable("gift_spends");

    await queryRunner.dropForeignKey(
      "gift_certificates",
      naming.foreignKeyName(
        "gift_certificates",
        ["activated_by_user_id"],
        "users",
        ["id"],
      ),
    );
    await queryRunner.dropForeignKey(
      "gift_certificates",
      naming.foreignKeyName(
        "gift_certificates",
        ["buyer_user_id"],
        "users",
        ["id"],
      ),
    );
    await queryRunner.dropIndex(
      "gift_certificates",
      naming.indexName("gift_certificates", ["activated_by_user_id"]),
    );
    await queryRunner.dropIndex(
      "gift_certificates",
      naming.indexName("gift_certificates", ["buyer_user_id"]),
    );
    await queryRunner.dropTable("gift_certificates");
  }
}
