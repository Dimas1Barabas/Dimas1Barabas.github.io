import {
  DefaultNamingStrategy,
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from "typeorm";

/**
 * Реферальная программа: три колонки users.
 *
 * referral_code — публичный код приглашения (уникален; у юзеров до
 * рефералки null — код догенерируется лениво при первом заходе на
 * «Пригласить»). referred_by — кем приглашён, фиксируется один раз при
 * регистрации. referral_rewarded_at — метка, что первая оплаченная
 * бронь приглашённого уже награждена: атомарный захват «первенца»
 * UPDATE ... WHERE referral_rewarded_at IS NULL RETURNING (гонка двух
 * одновременных оплат друга решается на уровне строки).
 */
export class AddReferralFields1795046400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();

    await queryRunner.addColumn(
      "users",
      new TableColumn({
        name: "referral_code",
        type: "varchar",
        length: "12",
        isNullable: true,
      }),
    );
    await queryRunner.addColumn(
      "users",
      new TableColumn({ name: "referred_by", type: "uuid", isNullable: true }),
    );
    await queryRunner.addColumn(
      "users",
      new TableColumn({
        name: "referral_rewarded_at",
        type: "timestamp",
        isNullable: true,
      }),
    );

    await queryRunner.createUniqueConstraint(
      "users",
      new TableUnique({
        name: "uq_users_referral_code",
        columnNames: ["referral_code"],
      }),
    );
    // статистика «Пригласить»: все приглашённые конкретного юзера
    await queryRunner.createIndex(
      "users",
      new TableIndex({
        name: naming.indexName("users", ["referred_by"]),
        columnNames: ["referred_by"],
      }),
    );
    await queryRunner.createForeignKey(
      "users",
      new TableForeignKey({
        name: naming.foreignKeyName(
          "users",
          ["referred_by"],
          "users",
          ["id"],
        ),
        columnNames: ["referred_by"],
        referencedTableName: "users",
        referencedColumnNames: ["id"],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const naming = new DefaultNamingStrategy();
    await queryRunner.dropForeignKey(
      "users",
      naming.foreignKeyName("users", ["referred_by"], "users", ["id"]),
    );
    await queryRunner.dropIndex(
      "users",
      naming.indexName("users", ["referred_by"]),
    );
    await queryRunner.dropUniqueConstraint("users", "uq_users_referral_code");
    await queryRunner.dropColumn("users", "referral_rewarded_at");
    await queryRunner.dropColumn("users", "referred_by");
    await queryRunner.dropColumn("users", "referral_code");
  }
}
