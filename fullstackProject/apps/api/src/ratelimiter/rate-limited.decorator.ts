import { SetMetadata } from '@nestjs/common';

export const RATE_LIMITED_ACTION = 'rateLimitedAction';

/** Действия из таблицы политик Привратника */
export type RateLimitedAction = 'bookings.create' | 'auth.login';

/**
 * Помечает маршрут для RateLimitGuard: действие лимитируется, ключ
 * гвард выберет сам (user id из JWT → email из тела → ip).
 */
export const RateLimited = (action: RateLimitedAction) =>
  SetMetadata(RATE_LIMITED_ACTION, action);
