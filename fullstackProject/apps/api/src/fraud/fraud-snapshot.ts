import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Срез истории покупателя для скоринга: факты, а не решение */
export interface FraudSnapshot {
  accountAgeDays: number;
  bookings24h: number;
  cancels24h: number;
  failed24h: number;
}

/**
 * Один SQL-запрос собирает всё, что Детективу нужно знать о покупателе:
 * возраст счёта, темп броней, шторм отмен и отказов оплаты за сутки.
 * Детектив сам в базу биллинга не ходит — скоринг синхронный, срез
 * фактов честнее собирать в источнике.
 *
 * Любой сбой — дефолтный «спокойный» срез: скоринг не должен валить
 * чекаут (fail-open, как у Привратника). Пустой ответ (счёт не нашли)
 * не наказываем: возраст не указываем, счётчики нулевые.
 */
const SNAPSHOT_SQL = `
  SELECT
    GREATEST(0, EXTRACT(DAY FROM (now() - u.created_at)))::int AS account_age_days,
    (SELECT COUNT(*)::int FROM bookings b
      WHERE b.user_id = u.id AND b.created_at > now() - interval '24 hours') AS bookings_24h,
    (SELECT COUNT(*)::int FROM bookings b
      WHERE b.user_id = u.id AND b.created_at > now() - interval '24 hours'
        AND b.status IN ('CANCELLED', 'EXPIRED')) AS cancels_24h,
    (SELECT COUNT(*)::int FROM bookings b
      WHERE b.user_id = u.id AND b.created_at > now() - interval '24 hours'
        AND b.status = 'FAILED') AS failed_24h
  FROM users u
  WHERE u.id = $1`;

/** спокойный срез: ничего, что насторожило бы правила */
export function calmSnapshot(): FraudSnapshot {
  return { accountAgeDays: 365, bookings24h: 0, cancels24h: 0, failed24h: 0 };
}

/**
 * Собрать срез истории покупателя. Счёт не нашли или БД ответила сбоем —
 * спокойный срез с warn: правило newAccount не должно срабатывать из-за
 * нашей же инфраструктуры.
 */
export async function fraudSnapshotOf(
  dataSource: DataSource,
  userId: string,
): Promise<FraudSnapshot> {
  try {
    const rows = await dataSource.query<
      {
        account_age_days: number;
        bookings_24h: number;
        cancels_24h: number;
        failed_24h: number;
      }[]
    >(SNAPSHOT_SQL, [userId]);
    const row = rows[0];
    if (!row) {
      return calmSnapshot();
    }
    return {
      accountAgeDays: Number(row.account_age_days ?? 0),
      bookings24h: Number(row.bookings_24h ?? 0),
      cancels24h: Number(row.cancels_24h ?? 0),
      failed24h: Number(row.failed_24h ?? 0),
    };
  } catch (err) {
    new Logger('fraudSnapshot').warn(
      `срез истории для скоринга не собрался (user ${userId}) — спокойный дефолт: ${String(err)}`,
    );
    return calmSnapshot();
  }
}
