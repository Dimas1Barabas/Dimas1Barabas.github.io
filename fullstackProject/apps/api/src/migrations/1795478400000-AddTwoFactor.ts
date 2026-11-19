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
 * Двухфакторная аутентификация (этап 34): TOTP RFC 6238.
 *
 * users.totp_secret / totp_enabled_at — секрет хранится в base32
 * (20 байт), включается только после подтверждения кодом: до этого
 * enabled_at пуст и логин идёт без второго шага. Отключение (или сброс
 * пароля по ссылке — recovery-канал) чистит обе колонки.
 *
 * backup_codes — одноразовые коды на случай утери телефона: наружу
 * показываются один раз при включении, в БД — только sha256-хэш,
 * расход атомарным UPDATE … WHERE used_at IS NULL.
 *
 * trusted_devices — «доверенное устройство» после входа с галочкой:
 * токен живёт в httpOnly-cookie, в БД — хэш; пока устройство живо,
 * вход по паролю не спрашивает код. Слайдинг-продление last_used_at,
 * отзыв из профиля гасит revoked_at.
 *
 * two_factor_challenges — короткоживующий билет между «пароль верен»
 * и «код верен»: хэш билета, TTL 5 минут, счётчик попыток (после
 * пяти неверных кодов билет гасится — брутфорцеру нужно начинать
 * вход заново, а корзина Привратника тем временем пустеет).
 */
export class AddTwoFactor1795478400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.addColumn(
      "users",
      new TableColumn({
        name: "totp_secret",
        type: "varchar",
        length: "64",
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      "users",
      new TableColumn({
        name: "totp_enabled_at",
        type: "timestamp",
        isNullable: true,
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "backup_codes",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "user_id", type: "uuid" },
          { name: "code_hash", type: "varchar", length: "64" },
          { name: "used_at", type: "timestamp", isNullable: true },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName("backup_codes", ["user_id"], "users", ["id"]),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
        ],
      }),
    );
    await queryRunner.createIndex(
      "backup_codes",
      new TableIndex({
        name: naming.indexName("backup_codes", ["user_id"]),
        columnNames: ["user_id"],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "trusted_devices",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "user_id", type: "uuid" },
          { name: "token_hash", type: "varchar", length: "64" },
          { name: "name", type: "varchar", length: "60" },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "last_used_at", type: "timestamp", default: "now()" },
          { name: "expires_at", type: "timestamp" },
          { name: "revoked_at", type: "timestamp", isNullable: true },
        ],
        uniques: [
          new TableUnique({
            name: "uq_trusted_devices_token_hash",
            columnNames: ["token_hash"],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName("trusted_devices", ["user_id"], "users", ["id"]),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
        ],
      }),
    );
    await queryRunner.createIndex(
      "trusted_devices",
      new TableIndex({
        name: naming.indexName("trusted_devices", ["user_id"]),
        columnNames: ["user_id"],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "two_factor_challenges",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "user_id", type: "uuid" },
          { name: "ticket_hash", type: "varchar", length: "64" },
          { name: "attempts", type: "integer", default: "0" },
          { name: "expires_at", type: "timestamp" },
          { name: "used_at", type: "timestamp", isNullable: true },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
        uniques: [
          new TableUnique({
            name: "uq_two_factor_challenges_ticket_hash",
            columnNames: ["ticket_hash"],
          }),
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName(
              "two_factor_challenges",
              ["user_id"],
              "users",
              ["id"],
            ),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
        ],
      }),
    );
    await queryRunner.createIndex(
      "two_factor_challenges",
      new TableIndex({
        name: naming.indexName("two_factor_challenges", ["user_id"]),
        columnNames: ["user_id"],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.dropIndex(
      "two_factor_challenges",
      naming.indexName("two_factor_challenges", ["user_id"]),
    );
    await queryRunner.dropTable("two_factor_challenges");

    await queryRunner.dropIndex(
      "trusted_devices",
      naming.indexName("trusted_devices", ["user_id"]),
    );
    await queryRunner.dropTable("trusted_devices");

    await queryRunner.dropIndex(
      "backup_codes",
      naming.indexName("backup_codes", ["user_id"]),
    );
    await queryRunner.dropTable("backup_codes");

    await queryRunner.dropColumn("users", "totp_enabled_at");
    await queryRunner.dropColumn("users", "totp_secret");
  }
}
