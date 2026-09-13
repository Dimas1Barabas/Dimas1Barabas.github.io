import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

/**
 * Оплата + lifecycle брони: бронь рождается в PENDING_PAYMENT с дедлайном
 * оплаты expires_at; неоплаченная вовремя — EXPIRED, места освобождаются.
 *
 * Написана руками по образцу AddSessions (Table API, имена не участвуют).
 * changeColumn расширяет varchar(16) → varchar(24): «PENDING_PAYMENT» —
 * 15 символов, впритык к старой длине (widening в PG — metadata-only).
 * Дефолт статуса переезжает с 'PENDING' на 'PENDING_PAYMENT'.
 *
 * Legacy-строки: брони в PENDING не имеют события в wait-очереди — таймаут
 * по ним никогда не сработает, поэтому честно гасим их в EXPIRED и сразу
 * освобождаем их места (сначала статус, потом выборка мест по нему).
 *
 * down() — с потерями: EXPIRED → FAILED (ближайший по смыслу «места
 * освобождены»), PENDING_PAYMENT → PENDING, expires_at теряется.
 */
export class AddPaymentLifecycle1789257600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      "bookings",
      new TableColumn({
        name: "expires_at",
        type: "timestamptz",
        isNullable: true,
      }),
    );

    await queryRunner.changeColumn(
      "bookings",
      "status",
      new TableColumn({
        name: "status",
        type: "varchar",
        length: "24",
        default: "'PENDING_PAYMENT'",
      }),
    );

    await queryRunner.query(
      `UPDATE bookings SET status = 'EXPIRED',
         message = 'Резерв истёк: бронь создана до фичи оплаты'
       WHERE status = 'PENDING'`,
    );
    await queryRunner.query(
      `DELETE FROM seat_occupancy WHERE booking_id IN (
         SELECT id FROM bookings WHERE status = 'EXPIRED')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE bookings SET status = 'PENDING' WHERE status = 'PENDING_PAYMENT'`,
    );
    await queryRunner.query(
      `UPDATE bookings SET status = 'FAILED' WHERE status = 'EXPIRED'`,
    );
    await queryRunner.changeColumn(
      "bookings",
      "status",
      new TableColumn({
        name: "status",
        type: "varchar",
        length: "16",
        default: "'PENDING'",
      }),
    );
    await queryRunner.dropColumn("bookings", "expires_at");
  }
}
