import {
  DefaultNamingStrategy,
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from "typeorm";

/**
 * Кинобар (этап 32): предзаказ попкорна и напитков к сеансу.
 *
 * bar_items — каталог с остатками: списание идёт атомарным
 * UPDATE … SET stock = stock - :qty WHERE id = :id AND stock >= :qty
 * (порция за порцией, в транзакции заказа) — отрицательный остаток
 * невозможен без CHECK-констрейнта, гонка за последнюю порцию
 * проигрывается affected-строками: 0 → 409 OUT_OF_STOCK.
 *
 * bar_orders / bar_order_items — заказ и позиции со снимками имени/цены
 * (прайс меняется — состав заказа остаётся фактом). Статусы заказа
 * гоняет Бармен (NEW → PREPARING → READY → PICKED_UP), отмена возможна
 * на NEW/PREPARING с возвратом остатков; API слушает bar.order.status.
 * uq (order_id, item_id) — арбитр дубля позиции, как у waitlist.
 */
export class AddBar1795305600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "bar_items",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "slug", type: "varchar", length: "32" },
          { name: "name", type: "varchar", length: "64" },
          { name: "category", type: "varchar", length: "16" },
          { name: "price_rub", type: "integer" },
          { name: "stock", type: "integer" },
          { name: "active", type: "boolean", default: true },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "updated_at", type: "timestamp", default: "now()" },
        ],
        uniques: [
          new TableUnique({ name: "uq_bar_items_slug", columnNames: ["slug"] }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "bar_orders",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "user_id", type: "uuid" },
          { name: "session_id", type: "uuid", isNullable: true },
          { name: "status", type: "varchar", length: "16" },
          { name: "total_rub", type: "integer" },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "updated_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName("bar_orders", ["user_id"], "users", ["id"]),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
          new TableForeignKey({
            name: naming.foreignKeyName(
              "bar_orders",
              ["session_id"],
              "sessions",
              ["id"],
            ),
            columnNames: ["session_id"],
            referencedTableName: "sessions",
            referencedColumnNames: ["id"],
          }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("bar_orders", ["user_id"]),
            columnNames: ["user_id"],
          }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "bar_order_items",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "order_id", type: "uuid" },
          { name: "item_id", type: "uuid" },
          { name: "name", type: "varchar", length: "64" },
          { name: "price_rub", type: "integer" },
          { name: "qty", type: "integer" },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName(
              "bar_order_items",
              ["order_id"],
              "bar_orders",
              ["id"],
            ),
            columnNames: ["order_id"],
            referencedTableName: "bar_orders",
            referencedColumnNames: ["id"],
            onDelete: "CASCADE",
          }),
          new TableForeignKey({
            name: naming.foreignKeyName(
              "bar_order_items",
              ["item_id"],
              "bar_items",
              ["id"],
            ),
            columnNames: ["item_id"],
            referencedTableName: "bar_items",
            referencedColumnNames: ["id"],
          }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("bar_order_items", ["order_id"]),
            columnNames: ["order_id"],
          }),
        ],
        uniques: [
          new TableUnique({
            name: "uq_bar_order_item",
            columnNames: ["order_id", "item_id"],
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("bar_order_items");
    await queryRunner.dropTable("bar_orders");
    await queryRunner.dropTable("bar_items");
  }
}
