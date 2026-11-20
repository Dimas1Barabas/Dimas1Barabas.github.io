import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { calmSnapshot, fraudSnapshotOf } from './fraud-snapshot';

/** фейковый DataSource: только query — снапшот больше ничего не трогает */
function dataSourceOf(
  rows: unknown | Error,
): DataSource & { __sql: string[]; __params: unknown[][] } {
  const seen: { sql: string[]; params: unknown[][] } = {
    sql: [],
    params: [],
  };
  const ds = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      seen.sql.push(sql);
      seen.params.push(params);
      if (rows instanceof Error) throw rows;
      return rows;
    }),
  } as unknown as DataSource & { __sql: string[]; __params: unknown[][] };
  Object.defineProperty(ds, '__sql', { get: () => seen.sql });
  Object.defineProperty(ds, '__params', { get: () => seen.params });
  return ds;
}

describe('fraudSnapshotOf (unit)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('собирает срез одной параметризованной записью', async () => {
    const ds = dataSourceOf([
      { account_age_days: 3, bookings_24h: 5, cancels_24h: 2, failed_24h: 1 },
    ]);

    const snap = await fraudSnapshotOf(ds, 'user-1');

    expect(snap).toEqual({
      accountAgeDays: 3,
      bookings24h: 5,
      cancels24h: 2,
      failed24h: 1,
    });
    // один запрос, пользователь — параметром (не конкатенацией)
    expect(ds.__sql).toHaveLength(1);
    expect(ds.__sql[0]).toContain('FROM users u');
    expect(ds.__params[0]).toEqual(['user-1']);
  });

  it('счёт не найден — спокойный срез, не наказываем покупателя', async () => {
    const ds = dataSourceOf([]);

    await expect(fraudSnapshotOf(ds, 'нет-такого')).resolves.toEqual(
      calmSnapshot(),
    );
  });

  it('сбой БД — спокойный срез (fail-open скоринга)', async () => {
    const ds = dataSourceOf(new Error('connection refused'));

    await expect(fraudSnapshotOf(ds, 'user-1')).resolves.toEqual(
      calmSnapshot(),
    );
  });
});
