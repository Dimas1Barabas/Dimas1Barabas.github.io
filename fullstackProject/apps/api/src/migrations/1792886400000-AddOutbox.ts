import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
} from "typeorm";

/**
 * Транзакционный outbox: события, чья публикация обязана пережить крах
 * API, пишутся в outbox_messages В ТОЙ ЖЕ транзакции, что и бизнес-данные.
 * Публикацией владеет отдельный релей (services/outbox-relay, «Курьер»):
 * выборка FOR UPDATE SKIP LOCKED → publish в exchange cinema → published_at;
 * сбой — attempts+1 и next_attempt_at с бэкоффом, сообщения не дропаются.
 *
 * headers — amqp-заголовки на момент записи (traceparent): релей публикует
 * их позже, но трейс остаётся трейсом исходной операции. Частичный индекс
 * по next_attempt_at держит скан pending-хвоста дешёвым при росте таблицы.
 */
export class AddOutbox1792886400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "outbox_messages",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "routing_key", type: "varchar", length: "100" },
          { name: "payload", type: "jsonb" },
          { name: "headers", type: "jsonb", default: "'{}'" },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "published_at", type: "timestamp", isNullable: true },
          { name: "attempts", type: "int", default: "0" },
          { name: "next_attempt_at", type: "timestamp", default: "now()" },
          { name: "last_error", type: "text", isNullable: true },
        ],
        indices: [
          new TableIndex({
            name: "idx_outbox_pending",
            columnNames: ["next_attempt_at"],
            where: "published_at IS NULL",
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("outbox_messages");
  }
}
