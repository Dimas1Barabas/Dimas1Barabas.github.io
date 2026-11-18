import {
  ConflictException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { GiftCertificate } from './gift-certificate.entity';

/** номиналы — круглые суммы, какие печатают на подарочных картах */
export const GIFT_NOMINAL_MIN = 500;
export const GIFT_NOMINAL_MAX = 50_000;
export const GIFT_NOMINAL_STEP = 100;
/** срок жизни карты с момента покупки — и на активацию, и на трату */
export const GIFT_TTL_DAYS = 365;

/** ошибка номинала или null: границы и кратность — один источник для
 *  DTO-сообщения и демо-режима (зеркало на фронте) */
export function nominalError(nominalRub: number): string | null {
  if (!Number.isInteger(nominalRub)) {
    return `Номинал — целое число рублей`;
  }
  if (nominalRub < GIFT_NOMINAL_MIN || nominalRub > GIFT_NOMINAL_MAX) {
    return `Номинал — от ${GIFT_NOMINAL_MIN} до ${GIFT_NOMINAL_MAX} ₽`;
  }
  if (nominalRub % GIFT_NOMINAL_STEP !== 0) {
    return `Номинал — круглая сумма, кратная ${GIFT_NOMINAL_STEP} ₽`;
  }
  return null;
}

/** момент истечения карты: покупка + GIFT_TTL_DAYS */
export function giftExpiresAt(now: Date = new Date()): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + GIFT_TTL_DAYS);
  return at;
}

/**
 * Сколько снять с карты при оплате: не больше остатка чека и не больше
 * остатка карты — карта покрывает хвост частично, остальное платит
 * касса. 0 означает «карта не нужна» (чек уже закрыт промокодом и
 * бонусами) — чистая функция, единый источник для API и демо-режима.
 */
export function giftSpendAmount(
  remainingRub: number,
  restRub: number,
): number {
  return Math.max(0, Math.min(remainingRub, restRub));
}

/**
 * Причина отказа активации по свежепрочитанной карте (null — код не
 * найден). Единый источник для повторной активации, опечатки и
 * просрочки: выигравший в гонке за код активировал карту, проигравший
 * получает 409 giftAlreadyActivated.
 */
export function giftActivationRefusalError(
  cert: GiftCertificate | null,
): HttpException {
  if (!cert) {
    return new NotFoundException({
      statusCode: 404,
      error: 'Not Found',
      message: 'Сертификат с таким кодом не найден',
      code: 'giftNotFound',
    });
  }
  if (cert.expiresAt.getTime() <= Date.now()) {
    return new GoneException({
      statusCode: 410,
      error: 'Gone',
      message: `Срок действия сертификата ${cert.code} истёк`,
      code: 'giftExpired',
    });
  }
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: `Сертификат ${cert.code} уже активирован`,
    code: 'giftAlreadyActivated',
  });
}

/**
 * Причина отказа списания (карту не удалось списать в оплате) по
 * свежепрочитанной строке: не ваша / не активирована / просрочена /
 * исчерпана; null-строка — 404. Гонку за последний рубль решает БД —
 * проигравший маппится сюда же как giftExhausted.
 */
export function giftSpendRefusalError(
  cert: GiftCertificate | null,
  userId: string,
): HttpException {
  if (!cert) {
    return new NotFoundException({
      statusCode: 404,
      error: 'Not Found',
      message: 'Сертификат с таким кодом не найден',
      code: 'giftNotFound',
    });
  }
  if (cert.activatedByUserId !== userId) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: cert.status === 'purchased'
        ? `Сертификат ${cert.code} ещё не активирован — активируйте код на странице «Подарки»`
        : `Сертификат ${cert.code} активирован другим зрителем`,
      code: 'giftNotYours',
    });
  }
  if (cert.expiresAt.getTime() <= Date.now()) {
    return new GoneException({
      statusCode: 410,
      error: 'Gone',
      message: `Срок действия сертификата ${cert.code} истёк`,
      code: 'giftExpired',
    });
  }
  if (cert.remainingRub <= 0) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: `Сертификат ${cert.code} потрачен полностью`,
      code: 'giftExhausted',
    });
  }
  // карта ваша, жива и с деньгами — списание сорвала параллельная
  // оплата: остаток изменился после нашего чтения, транзакция
  // откатилась целиком (ровно как гонка за последний промокод)
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: `Остаток сертификата ${cert.code} только что изменился параллельной оплатой — повторите оплату`,
    code: 'giftExhausted',
  });
}
