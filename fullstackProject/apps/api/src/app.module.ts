import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsModule } from './bookings/bookings.module';
import { dataSourceOptions } from './data-source';
import { HealthController } from './health/health.controller';
import { MoviesModule } from './movies/movies.module';
import { rabbitMqModule } from './rabbit/rabbitmq.config';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // PostgreSQL — основное хранилище (фильмы, брони).
    // Опции общие с CLI миграций (src/data-source.ts).
    // Схему создают миграции: migrationsRun прогоняет их при старте,
    // до onModuleInit сервисов — поэтому посев фильмов работает как раньше.
    // В проде с несколькими репликами миграции выносят в отдельный шаг
    // деплоя; для одного инстанса автозапуск — норма.
    TypeOrmModule.forRoot({
      ...dataSourceOptions,
      autoLoadEntities: true,
      migrationsRun: true,
    }),

    // RabbitMQ — транспорт событий между API и Go-воркером
    rabbitMqModule,

    RedisModule,
    MoviesModule,
    BookingsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
