import {
  DefaultNamingStrategy,
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableForeignKey,
  TableIndex,
} from "typeorm";

/**
 * Расписание сеансов: у фильма становится много сеансов (зал + время),
 * бронь и занятость мест перепривязываются с фильма на сеанс.
 *
 * Написана руками по образцу InitialSchema: имена индексов/FK — те же,
 * что computes synchronize (DefaultNamingStrategy), чтобы будущие
 * migration:generate давали чистый diff.
 *
 * Перенос данных: единственный session_at каждого фильма становится
 * его первым сеансом (зал «Красный» — дефолт), bookings и seat_occupancy
 * получают session_id обратным lookup'ом по movie_id — соответствие
 * однозначное, сеансов пока по одному на фильм.
 *
 * down() — обратный перенос с потерей: movie.session_at = MIN(starts_at)
 * по сеансам фильма, лишние сеансы отбрасываются.
 */
export class AddSessions1789171200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.createTable(
      new Table({
        name: "sessions",
        columns: [
          { name: "id", type: "uuid", isPrimary: true, default: "gen_random_uuid()" },
          { name: "movie_id", type: "uuid" },
          { name: "hall", type: "varchar", length: "40" },
          { name: "starts_at", type: "timestamptz" },
          { name: "created_at", type: "timestamp", default: "now()" },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: naming.foreignKeyName("sessions", ["movie_id"], "movies", ["id"]),
            columnNames: ["movie_id"],
            referencedTableName: "movies",
            referencedColumnNames: ["id"],
          }),
        ],
        indices: [
          new TableIndex({
            name: naming.indexName("sessions", ["movie_id"]),
            columnNames: ["movie_id"],
          }),
        ],
      }),
    );

    // единственный сеанс каждого фильма переезжает в sessions
    await queryRunner.query(
      `INSERT INTO sessions (id, movie_id, hall, starts_at, created_at)
       SELECT gen_random_uuid(), id, 'Красный', session_at, now() FROM movies`,
    );

    // bookings.session_id: nullable-колонка → backfill → NOT NULL → FK
    // (nullable сначала — иначе заполнить существующие строки не удастся)
    await queryRunner.addColumn(
      "bookings",
      new TableColumn({ name: "session_id", type: "uuid", isNullable: true }),
    );
    await queryRunner.query(
      `UPDATE bookings b SET session_id = s.id
       FROM sessions s WHERE s.movie_id = b.movie_id`,
    );
    await queryRunner.changeColumn(
      "bookings",
      "session_id",
      new TableColumn({ name: "session_id", type: "uuid", isNullable: false }),
    );
    await queryRunner.createForeignKey(
      "bookings",
      new TableForeignKey({
        name: naming.foreignKeyName("bookings", ["session_id"], "sessions", ["id"]),
        columnNames: ["session_id"],
        referencedTableName: "sessions",
        referencedColumnNames: ["id"],
      }),
    );

    // seat_occupancy.session_id: колонка → backfill → NOT NULL → FK + uq + индекс
    await queryRunner.addColumn(
      "seat_occupancy",
      new TableColumn({ name: "session_id", type: "uuid", isNullable: true }),
    );
    await queryRunner.query(
      `UPDATE seat_occupancy o SET session_id = s.id
       FROM sessions s WHERE s.movie_id = o.movie_id`,
    );
    await queryRunner.changeColumn(
      "seat_occupancy",
      "session_id",
      new TableColumn({ name: "session_id", type: "uuid", isNullable: false }),
    );
    await queryRunner.createForeignKey(
      "seat_occupancy",
      new TableForeignKey({
        name: naming.foreignKeyName(
          "seat_occupancy",
          ["session_id"],
          "sessions",
          ["id"],
        ),
        columnNames: ["session_id"],
        referencedTableName: "sessions",
        referencedColumnNames: ["id"],
      }),
    );
    // uq-констрейнт — SQL'ом: у Postgres-QueryRunner нет createUnique
    await queryRunner.query(
      `ALTER TABLE seat_occupancy
       ADD CONSTRAINT uq_session_seat UNIQUE (session_id, seat)`,
    );
    await queryRunner.createIndex(
      "seat_occupancy",
      new TableIndex({
        name: naming.indexName("seat_occupancy", ["session_id"]),
        columnNames: ["session_id"],
      }),
    );

    // старая привязка к фильму уходит: сначала её констрейнты, потом колонки
    await queryRunner.query(`ALTER TABLE seat_occupancy DROP CONSTRAINT uq_movie_seat`);
    await queryRunner.dropIndex(
      "seat_occupancy",
      naming.indexName("seat_occupancy", ["movie_id"]),
    );
    await queryRunner.dropColumn("seat_occupancy", "movie_id");
    await queryRunner.dropColumn("movies", "session_at");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    // movies.session_at: ближайший сеанс (MIN); лишние — теряются
    await queryRunner.addColumn(
      "movies",
      new TableColumn({ name: "session_at", type: "timestamptz", isNullable: true }),
    );
    await queryRunner.query(
      `UPDATE movies m SET session_at = (
         SELECT MIN(s.starts_at) FROM sessions s WHERE s.movie_id = m.id
       )`,
    );
    await queryRunner.changeColumn(
      "movies",
      "session_at",
      new TableColumn({ name: "session_at", type: "timestamptz", isNullable: false }),
    );

    // seat_occupancy.movie_id обратно (FK на movies у неё и не было)
    await queryRunner.addColumn(
      "seat_occupancy",
      new TableColumn({ name: "movie_id", type: "uuid", isNullable: true }),
    );
    await queryRunner.query(
      `UPDATE seat_occupancy o SET movie_id = s.movie_id
       FROM sessions s WHERE s.id = o.session_id`,
    );
    await queryRunner.changeColumn(
      "seat_occupancy",
      "movie_id",
      new TableColumn({ name: "movie_id", type: "uuid", isNullable: false }),
    );
    await queryRunner.createIndex(
      "seat_occupancy",
      new TableIndex({
        name: naming.indexName("seat_occupancy", ["movie_id"]),
        columnNames: ["movie_id"],
      }),
    );
    await queryRunner.query(
      `ALTER TABLE seat_occupancy
       ADD CONSTRAINT uq_movie_seat UNIQUE (movie_id, seat)`,
    );

    // сносим session-привязку
    await queryRunner.query(`ALTER TABLE seat_occupancy DROP CONSTRAINT uq_session_seat`);
    await queryRunner.dropIndex(
      "seat_occupancy",
      naming.indexName("seat_occupancy", ["session_id"]),
    );
    await queryRunner.dropForeignKey(
      "seat_occupancy",
      naming.foreignKeyName("seat_occupancy", ["session_id"], "sessions", ["id"]),
    );
    await queryRunner.dropColumn("seat_occupancy", "session_id");
    await queryRunner.dropForeignKey(
      "bookings",
      naming.foreignKeyName("bookings", ["session_id"], "sessions", ["id"]),
    );
    await queryRunner.dropColumn("bookings", "session_id");
    await queryRunner.dropTable("sessions");
  }
}
