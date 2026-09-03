import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsModule } from './bookings/bookings.module';
import { HealthController } from './health/health.controller';
import { MoviesModule } from './movies/movies.module';
import { rabbitMqModule } from './rabbit/rabbitmq.config';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // PostgreSQL — основное хранилище (фильмы, брони)
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>(
          'DATABASE_URL',
          'postgres://cine:cine@localhost:5432/cine',
        ),
        autoLoadEntities: true,
        // удобно для демо; в проде — миграции
        synchronize: config.get('TYPEORM_SYNCHRONIZE', 'true') === 'true',
      }),
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
