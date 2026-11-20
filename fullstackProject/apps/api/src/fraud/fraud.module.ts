import { Module } from '@nestjs/common';
import { DetectiveClient } from './detective.client';
import { DetectiveShowcaseClient } from './detective-showcase.client';

/**
 * Один экземпляр клиентов на всё приложение: BookingsModule (скоринг
 * чекаута) и AdminModule (витрина решений + резолвы) импортируют этот
 * модуль — ленивое gRPC-соединение общее. Сам модуль контроллеров не
 * имеет: админ-маршруты живут в AdminModule (иначе цикл модулей —
 * витрине нужен BookingsService для системной оплаты/отмены).
 */
@Module({
  providers: [DetectiveClient, DetectiveShowcaseClient],
  exports: [DetectiveClient, DetectiveShowcaseClient],
})
export class FraudModule {}
