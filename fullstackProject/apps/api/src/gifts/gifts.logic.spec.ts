import { generateGiftCode, normalizeGiftCode } from './gift-code';
import {
  giftActivationRefusalError,
  giftExpiresAt,
  giftSpendAmount,
  giftSpendRefusalError,
  GIFT_TTL_DAYS,
  nominalError,
} from './gifts.logic';
import { GiftCertificate } from './gift-certificate.entity';

/** строка карты, достаточная для всех отказов и расчётов */
function cert(overrides: Partial<GiftCertificate> = {}): GiftCertificate {
  return {
    id: 'cert-1',
    code: 'GIFT-AB2CD3EF',
    nominalRub: 2000,
    remainingRub: 2000,
    status: 'active',
    buyerUserId: 'buyer-1',
    activatedByUserId: 'user-1',
    activatedAt: new Date('2026-11-18T10:00:00Z'),
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date('2026-11-18T09:00:00Z'),
    updatedAt: new Date('2026-11-18T10:00:00Z'),
    ...overrides,
  } as GiftCertificate;
}

describe('номиналы сертификатов', () => {
  it('границы и кратность — один источник сообщения', () => {
    expect(nominalError(499)).toMatch(/от 500/);
    expect(nominalError(50_100)).toMatch(/до 50/);
    expect(nominalError(501)).toMatch(/кратн/);
    expect(nominalError(1_550)).toMatch(/кратн/);
    expect(nominalError(500)).toBeNull();
    expect(nominalError(1_500)).toBeNull();
    expect(nominalError(50_000)).toBeNull();
  });

  it('нецелые номиналы отбиваются до БД', () => {
    expect(nominalError(1_999.99)).toMatch(/целое/);
    expect(nominalError(Number.NaN)).toMatch(/целое/);
  });

  it('срок карты — покупка плюс год, время дня сохраняется', () => {
    const now = new Date('2026-11-18T15:30:00Z');
    const at = giftExpiresAt(now);
    expect(at.getTime() - now.getTime()).toBe(GIFT_TTL_DAYS * 86_400_000);
  });
});

describe('сумма списания карты', () => {
  it('не больше остатка чека и не больше остатка карты', () => {
    expect(giftSpendAmount(2_000, 800)).toBe(800);
    expect(giftSpendAmount(500, 800)).toBe(500);
    expect(giftSpendAmount(0, 800)).toBe(0);
    expect(giftSpendAmount(2_000, 0)).toBe(0);
  });
});

describe('коды сертификатов', () => {
  it('формат: GIFT- и 8 символов Crockford base32', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateGiftCode()).toMatch(/^GIFT-[0-9A-HJKMNP-TV-Z]{8}$/);
    }
  });

  it('нормализация: обводки пробелами и регистр', () => {
    expect(normalizeGiftCode('  gift-ab2cd3ef ')).toBe('GIFT-AB2CD3EF');
  });
});

describe('отказ активации', () => {
  it('код не найден — 404 giftNotFound', () => {
    const err = giftActivationRefusalError(null);
    expect(err.getStatus()).toBe(404);
    expect((err.getResponse() as { code: string }).code).toBe('giftNotFound');
  });

  it('срок истёк — 410 giftExpired', () => {
    const expired = cert({
      status: 'purchased',
      expiresAt: new Date(Date.now() - 1_000),
    });
    const err = giftActivationRefusalError(expired);
    expect(err.getStatus()).toBe(410);
    expect((err.getResponse() as { code: string }).code).toBe('giftExpired');
  });

  it('уже активирована — 409 giftAlreadyActivated', () => {
    const err = giftActivationRefusalError(cert());
    expect(err.getStatus()).toBe(409);
    expect((err.getResponse() as { code: string }).code).toBe(
      'giftAlreadyActivated',
    );
  });
});

describe('отказ списания', () => {
  it('код не найден — 404', () => {
    const err = giftSpendRefusalError(null, 'user-1');
    expect(err.getStatus()).toBe(404);
    expect((err.getResponse() as { code: string }).code).toBe('giftNotFound');
  });

  it('карта чужая — 409 giftNotYours', () => {
    const err = giftSpendRefusalError(
      cert({ activatedByUserId: 'someone-else' }),
      'user-1',
    );
    expect(err.getStatus()).toBe(409);
    expect((err.getResponse() as { code: string }).code).toBe('giftNotYours');
  });

  it('карта не активирована — подсказка активировать', () => {
    const err = giftSpendRefusalError(
      cert({ status: 'purchased', activatedByUserId: null }),
      'user-1',
    );
    const body = err.getResponse() as { code: string; message: string };
    expect(body.code).toBe('giftNotYours');
    expect(body.message).toMatch(/активируйте код/);
  });

  it('срок истёк — 410', () => {
    const err = giftSpendRefusalError(
      cert({ expiresAt: new Date(Date.now() - 1_000) }),
      'user-1',
    );
    expect(err.getStatus()).toBe(410);
    expect((err.getResponse() as { code: string }).code).toBe('giftExpired');
  });

  it('исчерпана и гонка — 409 giftExhausted', () => {
    const exhausted = giftSpendRefusalError(
      cert({ remainingRub: 0, status: 'exhausted' }),
      'user-1',
    );
    expect(exhausted.getStatus()).toBe(409);
    expect((exhausted.getResponse() as { code: string }).code).toBe(
      'giftExhausted',
    );

    // карта жива, но списание сорвала параллельная оплата
    const raced = giftSpendRefusalError(cert({ remainingRub: 300 }), 'user-1');
    expect(raced.getStatus()).toBe(409);
    expect((raced.getResponse() as { message: string }).message).toMatch(
      /параллельной оплатой/,
    );
  });
});
