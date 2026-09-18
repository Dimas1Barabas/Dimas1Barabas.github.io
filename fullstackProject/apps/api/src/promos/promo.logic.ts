import {
  ConflictException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Promo, PromoKind } from './promo.entity';

/** единый вид кода: без пробелов по краям, в верхнем регистре */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Чистая функция скидки — один источник для оплаты (API), превью
 * на экране оплаты и демо-режима (зеркало на фронте).
 * percent — округление до рубля; fixed не уводит итог в минус:
 * скидка больше суммы означает «бесплатно» (итог 0).
 */
export function promoDiscount(
  totalRub: number,
  kind: PromoKind,
  value: number,
): number {
  if (kind === 'percent') {
    return Math.round((totalRub * value) / 100);
  }
  return Math.min(value, totalRub);
}

/**
 * Причина отказа по свежепрочитанному коду (null — код не найден).
 * Единый источник для превью (/promos/validate) и оплаты (pay):
 * выигравший в гонке за последний код списал активацию, проигравший
 * получает 409 promoExhausted.
 */
export function promoRefusalError(promo: Promo | null): HttpException {
  if (!promo) {
    return new NotFoundException({
      statusCode: 404,
      error: 'Not Found',
      message: 'Промокод не найден',
      code: 'promoNotFound',
    });
  }
  if (promo.expiresAt.getTime() <= Date.now()) {
    return new GoneException({
      statusCode: 410,
      error: 'Gone',
      message: `Срок действия промокода ${promo.code} истёк`,
      code: 'promoExpired',
    });
  }
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: `Лимит активаций промокода ${promo.code} исчерпан`,
    code: 'promoExhausted',
  });
}
