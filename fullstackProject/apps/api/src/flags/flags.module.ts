import { Module } from '@nestjs/common';
import { FeatureFlagGuard } from './feature-flag.guard';
import { FlagsAdminController } from './flags-admin.controller';
import { FlagsController } from './flags.controller';
import { FlagsClient } from './flags.client';
import { FlagsEvaluator } from './flags.evaluator';
import { FlagsRevisionsClient } from './flags-revisions.client';

/**
 * Один экземпляр клиента на всё приложение: гварды маршрутов и админка
 * делят кэш состояний (FlagsEvaluator). Модуль импортируют контроллеры
 * с @FeatureFlag — гвард берётся отсюда же.
 */
@Module({
  controllers: [FlagsAdminController, FlagsController],
  providers: [FlagsClient, FlagsRevisionsClient, FlagsEvaluator, FeatureFlagGuard],
  exports: [FlagsEvaluator, FeatureFlagGuard],
})
export class FlagsModule {}
