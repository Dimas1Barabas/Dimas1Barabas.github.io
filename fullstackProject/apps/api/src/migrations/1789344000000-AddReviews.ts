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
 * Отзывы и рейтинги: таблица reviews + денормализованные агрегаты
 * rating_avg/rating_count на movies.
 *
 * Написана руками по образцу InitialSchema/AddSessions: имена индексов/FK —
 * те же, что computes synchronize (DefaultNamingStrategy), чтобы будущие
 * migration:generate давали чистый diff. uq-констрейнт нового стола живёт
 * прямо в createTable (raw SQL нужен только для ALTER существующего).
 *
 * Переноса данных нет: у существующих фильмов агрегаты честно нулевые,
 * пересчёт — задача кода (той же транзакацией, что и запись отзыва).
 */
export class AddReviews1789344000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "reviews",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "movie_id", type: "uuid" },
          { name: "user_id", type: "uuid" },
          { name: "rating", type: "smallint" },
          { name: "text", type: "varchar", length: "1000" },
          { name: "created_at", type: "timestamp", default: "now()" },
          { name: "updated_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName("reviews", ["movie_id"], "movies", ["id"]),
            columnNames: ["movie_id"],
            referencedTableName: "movies",
            referencedColumnNames: ["id"],
          }),
          new TableForeignKey({
            name: naming.foreignKeyName("reviews", ["user_id"], "users", ["id"]),
            columnNames: ["user_id"],
            referencedTableName: "users",
            referencedColumnNames: ["id"],
          }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("reviews", ["movie_id"]),
            columnNames: ["movie_id"],
          }),
          new TableIndex({
            name: naming.indexName("reviews", ["user_id"]),
            columnNames: ["user_id"],
          }),
        ],
        uniques: [
          new TableUnique({
            name: "uq_reviews_user_movie",
            columnNames: ["user_id", "movie_id"],
          }),
        ],
      }),
    );

    // агрегаты рейтинга на фильме: средняя и число отзывов
    await queryRunner.addColumn(
      "movies",
      new TableColumn({
        name: "rating_avg",
        type: "double precision",
        default: "0",
      }),
    );
    await queryRunner.addColumn(
      "movies",
      new TableColumn({ name: "rating_count", type: "int", default: "0" }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn("movies", "rating_count");
    await queryRunner.dropColumn("movies", "rating_avg");
    await queryRunner.dropTable("reviews");
  }
}
