// Общие опции подключения для CLI-миграций и приложения (app.module.ts).
// CLI живёт вне Nest, поэтому .env подтягиваем вручную.
import { config as loadEnv } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Booking } from './bookings/booking.entity';
import { SeatOccupancy } from './bookings/seat-occupancy.entity';
import { Movie } from './movies/movie.entity';
import { User } from './users/user.entity';

// quiet: dotenv@17 по умолчанию печатает подсказку в stdout при каждом старте
loadEnv({ quiet: true });

/** Адрес БД: env-переменная или локальный docker compose (postgres на 15432). */
export const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://cine:cine@localhost:15432/cine';

/**
 * Под ts-node (typeorm-ts-node-commonjs) этот файл — src/data-source.ts,
 * в рантайме приложения (node dist/main.js) — dist/data-source.js.
 * Выбираем папку миграций по расширению собственного файла, чтобы одни
 * и те же опции работали и для CLI, и для migrationsRun в приложении.
 */
const isRunningFromTs = __filename.endsWith('.ts');

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: databaseUrl,
  // сущности перечислены явно — надёжнее glob'а; не забывать добавлять новые
  entities: [Movie, Booking, SeatOccupancy, User],
  migrations: [
    isRunningFromTs ? 'src/migrations/*.ts' : 'dist/migrations/*.js',
  ],
  // synchronize: намеренно нет — схему создают только миграции
};

/** DataSource для CLI (`npm run migration:*`); приложение его не инстанцирует. */
export default new DataSource(dataSourceOptions);
