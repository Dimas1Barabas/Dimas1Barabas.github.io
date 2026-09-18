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
 * Восстановление пароля: одноразовые ссылки-токены.
 *
 * В таблице — sha256-хэш токена (ссылка не хранится в открытом виде),
 * срок жизни 30 минут и метка used_at: одноразовость обеспечивает
 * условный UPDATE по used_at IS NULL (гонка двух кликов по ссылке
 * разрешается на стороне БД). Протухшие строки убираются лениво при
 * каждом запросе сброса — без cron.
 */
export class AddPasswordResets1789516800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "password_resets",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "user_id", type: "uuid" },
          { name: "token_hash", type: "varchar", length: "64" },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "expires_at", type: "timestamp" },
          { name: "used_at", type: "timestamp", isNullable: true },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName("password_resets", ["user_id"], "users", ["id"]),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("password_resets", ["user_id"]),
            columnNames: ["user_id"],
          }),
        ],
        uniques: [
          new TableUnique({
            name: "uq_password_resets_token_hash",
            columnNames: ["token_hash"],
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("password_resets");
  }
}
