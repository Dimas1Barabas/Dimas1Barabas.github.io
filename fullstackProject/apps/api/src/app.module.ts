import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { BarModule } from './bar/bar.module';
import { BonusModule } from './bonus/bonus.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { TypeOrmNotFoundFilter } from './exceptions/typeorm-not-found.filter';
import { BookingsModule } from './bookings/bookings.module';
import { dataSourceOptions } from './data-source';
import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { MoviesModule } from './movies/movies.module';
import { PromosModule } from './promos/promos.module';
import { rabbitMqModule } from './rabbit/rabbitmq.config';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { RemindersModule } from './reminders/reminders.module';
import { ReviewsModule } from './reviews/reviews.module';
import { RedisModule } from './redis/redis.module';
import { ReferralsModule } from './referrals/referrals.module';
import { SearchModule } from './search/search.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { UsersModule } from './users/users.module';
import { WaitlistModule } from './waitlist/waitlist.module';
import { FlagsModule } from './flags/flags.module';
import { FraudModule } from './fraud/fraud.module';
import { GiftsModule } from './gifts/gifts.module';
import { TwoFactorModule } from './twofactor/twofactor.module';
import { GroupsModule } from './groups/groups.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // PostgreSQL — основное хранилище (фильмы, брони).
    // Опции общие с CLI миграций (src/data-source.ts).
    // Схему создают миграции: migrationsRun прогоняет их при старте,
    // до onModuleInit сервисов — поэтому посев фильмов работает как раньше.
    // В проде с несколькими репликами миграции выносят в отдельный шаг
    // деплоя; для одного инстанса автозапуск — норма. RUN_MIGRATIONS=false
    // выключает автозапуск — второй+ под (канарейка, реплика) не гоняет
    // схему наперегонки с первым: миграции катит ровно один раннер.
    TypeOrmModule.forRoot({
      ...dataSourceOptions,
      autoLoadEntities: true,
      migrationsRun: process.env.RUN_MIGRATIONS !== 'false',
    }),

    // RabbitMQ — транспорт событий между API и Go-воркером
    rabbitMqModule,

    RedisModule,
    MetricsModule,
    MoviesModule,
    BookingsModule,
    // инжест событий поведения: веб → брокер → Go-Аналитик
    AnalyticsModule,
    ReviewsModule,
    // полнотекстовый поиск афиши: Meilisearch с ILIKE-фолбэком (этап 30)
    SearchModule,
    // внешние метаданные афиши: кино-справочник с breaker'ом, decorate
    // каталога и админский синк (этап 37); инжектится и в MoviesController
    EnrichmentModule,
    // реферальная программа: код приглашения + статистика (этап 31)
    ReferralsModule,
    // уровни лояльности «Киноман»: кэшбэк/бар/надбавки спроса по тратам
    // (этап 38); сервис инжектится в вердиктный цикл, кинобар и чекаут
    LoyaltyModule,
    // кинобар: каталог с остатками и предзаказы к сеансу (этап 32)
    BarModule,
    // гифт-сертификаты: подарочные карты, списание в оплате брони (этап 33)
    GiftsModule,
    // двухфакторная аутентификация: TOTP, backup-коды, доверенные
    // устройства; настройки в профиле, второй шаг — в AuthModule (этап 34)
    TwoFactorModule,
    // «Идём вместе»: групповой выбор мест — инвайт-ссылка, общая live-карта,
    // цветные пометки участников, фиксация по готовности всех (этап 40)
    GroupsModule,
    AdminModule,
    PromosModule,
    WaitlistModule,
    BonusModule,
    RecommendationsModule,
    RemindersModule,
    // тумблеры фич: локальный кэш состояний «Суфлёра», @FeatureFlag на
    // маршрутах и админка /admin/flags (этап флагов)
    FlagsModule,
    // антифрод «Детектив»: скоринг чекаута (gRPC) и витрина решений
    // для админки; админ-маршруты — в AdminModule (этап 36)
    FraudModule,

    // пользователи и авторизация: регистрация сейчас, логин+JWT дальше
    UsersModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [
    // все эндпоинты по умолчанию требуют JWT; витрина помечена @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // следом за JWT: сверка роли с @Roles(...) на админских эндпоинтах
    { provide: APP_GUARD, useClass: RolesGuard },
    // findOneByOrFail по несуществующему id → 404, не 500 (HTTP-пути)
    { provide: APP_FILTER, useClass: TypeOrmNotFoundFilter },
  ],
})
export class AppModule {}
