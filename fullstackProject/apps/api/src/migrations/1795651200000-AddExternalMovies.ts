import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Внешние метаданные афиши (этап 37): external_movies — 1:1 с movies,
 * PK = movie_id, FK с ON DELETE CASCADE (фильм удалили — внешняя строка
 * не переживает каталог). simple-array-колонки (genres/actors) лежат
 * csv в text, как и остальные csv-колонки проекта.
 */
export class AddExternalMovies1795651200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS external_movies (
         movie_id uuid PRIMARY KEY
           REFERENCES movies(id) ON DELETE CASCADE,
         rating real NOT NULL DEFAULT 0,
         votes integer NOT NULL DEFAULT 0,
         year integer NOT NULL DEFAULT 0,
         genres text NOT NULL DEFAULT '',
         country varchar NOT NULL DEFAULT '',
         director varchar NOT NULL DEFAULT '',
         actors text NOT NULL DEFAULT '',
         age_rating varchar NOT NULL DEFAULT '',
         trailer_url varchar NOT NULL DEFAULT '',
         source_poster_url varchar NOT NULL DEFAULT '',
         synced_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS external_movies`);
  }
}
