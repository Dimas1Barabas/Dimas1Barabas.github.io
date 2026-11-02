import { SetMetadata } from '@nestjs/common';

export const FEATURE_FLAG_KEY = 'featureFlag';

/**
 * Помечает маршрут флагом фичи для FeatureFlagGuard: флаг выключен
 * (или сущность вне раскатки) — маршрут отвечает 403 featureDisabled,
 * как будто фичи нет. Ключ флага — из каталога flag-catalog.ts.
 */
export const FeatureFlag = (key: string) => SetMetadata(FEATURE_FLAG_KEY, key);
