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
 * Начальная схема: movies, users, bookings, seat_occupancy.
 *
 * Написана руками (mirror сущностей), а не сгенерирована: генерация требует
 * живой пустой Postgres, а Table API здесь проходит тем же код-путём, что и
 * synchronize, — поэтому схема совпадает с прежней байт-в-байт по типам.
 *
 * Отклонение от synchronize одно, осознанное: PRIMARY KEY по умолчанию
 * DEFAULT gen_random_uuid() вместо uuid_generate_v4(). PG13+ умеет его
 * без extension'ов (стенд — postgres:16), а TypeORM при чтении схемы
 * распознаёт его как generated-uuid — будущие migration:generate дают
 * чистый diff.
 *
 * created_at/updated_at — timestamp БЕЗ временной зоны: таков дефолт
 * @CreateDateColumn/@UpdateDateColumn в postgres-драйвере TypeORM
 * (mappedDataTypes.createDate = "timestamp"). session_at/processed_at
 * в сущностях объявлены timestamptz явно.
 */
export class InitialSchema1788887934432 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // имена индексов/FK — те же, что computes synchronize (IDX_<hash>/FK_<hash>),
    // чтобы diff «сущности ↔ БД» в migration:generate оставался пустым
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "movies",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "title", type: "varchar" },
          { name: "description", type: "varchar" },
          { name: "genre", type: "varchar" },
          { name: "genre_icon", type: "varchar" },
          { name: "duration_min", type: "smallint" },
          { name: "price_rub", type: "smallint" },
          { name: "hue", type: "smallint" },
          { name: "session_at", type: "timestamptz" },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "users",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "email", type: "varchar", length: "255" },
          { name: "password_hash", type: "varchar", length: "100" },
          { name: "name", type: "varchar", length: "60" },
          { name: "role", type: "varchar", length: "10", default: "'user'" },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
        uniques: [
          // повторный email → 23505 → 409 emailTaken (users.service)
          new TableUnique({ name: "uq_users_email", columnNames: ["email"] }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "bookings",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "movie_id", type: "uuid" },
          { name: "customer_name", type: "varchar", length: "60" },
          // null — брони, созданные до авторизации
          { name: "user_id", type: "uuid", isNullable: true },
          { name: "seats", type: "jsonb" },
          { name: "total_rub", type: "int" },
          { name: "status", type: "varchar", length: "16", default: "'PENDING'" },
          { name: "message", type: "text", isNullable: true },
          { name: "processed_by", type: "varchar", length: "64", isNullable: true },
          { name: "processed_at", type: "timestamptz", isNullable: true },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "updated_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName("bookings", ["movie_id"], "movies", ["id"]),
            columnNames: ["movie_id"],
            referencedTableName: "movies",
            referencedColumnNames: ["id"],
          }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: "seat_occupancy",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "movie_id", type: "uuid" },
          { name: "seat", type: "varchar", length: "8" },
          { name: "booking_id", type: "uuid" },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
        uniques: [
          // единственный арбитр в гонке за место: проигравший получает 23505 → 409 seatsTaken
          new TableUnique({ name: "uq_movie_seat", columnNames: ["movie_id", "seat"] }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("seat_occupancy", ["movie_id"]),
            columnNames: ["movie_id"],
          }),
          new TableIndex({
            name: naming.indexName("seat_occupancy", ["booking_id"]),
            columnNames: ["booking_id"],
          }),
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // в порядке, обратном зависимостям (bookings ссылается на movies)
    await queryRunner.dropTable("seat_occupancy");
    await queryRunner.dropTable("bookings");
    await queryRunner.dropTable("users");
    await queryRunner.dropTable("movies");
  }
}
