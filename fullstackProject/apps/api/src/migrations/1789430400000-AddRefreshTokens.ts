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
 * Refresh-сессии: таблица refresh_tokens для ротации токенов.
 *
 * В БД лежит только sha256-хэш токена — утёкшая база не даёт живых сессий.
 * Ротация и reuse-detection — условными UPDATE по revoked_at IS NULL,
 * отдельная колонка-метка вместо удаления сохраняет историю «кто и когда
 * выходил». Протухшие строки убираются лениво (без cron) при revokeAll.
 *
 * Написана руками по образцу AddReviews: имена индексов/FK — те же,
 * что computes synchronize (DefaultNamingStrategy).
 */
export class AddRefreshTokens1789430400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "refresh_tokens",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "user_id", type: "uuid" },
          // sha256 hex — ровно 64 символа
          { name: "token_hash", type: "varchar", length: "64" },
          { name: "created_at", type: "timestamp", default: "now()" },
          // срок жизни сессии — 30 дней от выдачи
          { name: "expires_at", type: "timestamp" },
          { name: "revoked_at", type: "timestamp", isNullable: true },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName("refresh_tokens", ["user_id"], "users", ["id"]),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("refresh_tokens", ["user_id"]),
            columnNames: ["user_id"],
          }),
        ],
        uniques: [
          new TableUnique({
            name: "uq_refresh_tokens_token_hash",
            columnNames: ["token_hash"],
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("refresh_tokens");
  }
}
