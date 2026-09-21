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
 * Лист ожидания: waitlist_entries — кто хочет на место полного сеанса.
 *
 * Честная гонка: при освобождении места уведомляется только голова
 * (старейшая WAITING по queued_at), место никому не резервируется.
 * uq (session_id, user_id) — арбитр дубля (второй join → 23505 → 409),
 * как uq_reviews_user_movie. Повторный вход после NOTIFIED/LEFT
 * обновляет queued_at — запись встаёт в конец очереди.
 */
export class AddWaitlist1789776000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "waitlist_entries",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "session_id", type: "uuid" },
          { name: "user_id", type: "uuid" },
          { name: "status", type: "varchar", length: "16" },
          { name: "queued_at", type: "timestamptz" },
          { name: "notified_at", type: "timestamptz", isNullable: true },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "updated_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName(
              "waitlist_entries",
              ["session_id"],
              "sessions",
              ["id"],
            ),
            columnNames: ["session_id"],
            referencedTableName: "sessions",
            referencedColumnNames: ["id"],
          }),
          new TableForeignKey({
            name: naming.foreignKeyName(
              "waitlist_entries",
              ["user_id"],
              "users",
              ["id"],
            ),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("waitlist_entries", ["session_id"]),
            columnNames: ["session_id"],
          }),
          new TableIndex({
            name: naming.indexName("waitlist_entries", ["user_id"]),
            columnNames: ["user_id"],
          }),
        ],
        uniques: [
          new TableUnique({
            name: "uq_waitlist_session_user",
            columnNames: ["session_id", "user_id"],
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("waitlist_entries");
  }
}
