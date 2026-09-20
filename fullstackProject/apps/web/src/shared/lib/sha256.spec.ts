import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, sha256Hex } from './sha256';

/**
 * Эталоны: фиксированные векторы FIPS 180-2 / RFC 4231 плюс сверка с
 * node:crypto на случайных входах — та же функция, что подписывает
 * билеты в API (apps/api/src/bookings/ticket.logic.ts).
 */

describe('sha256Hex', () => {
  it('пустая строка — известный вектор', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('«abc» — известный вектор', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('кириллица (многобайтный UTF-8) — как node:crypto', () => {
    const s = 'Бронь 5-7, Млечный Путь: Операция «Туманность» 🎟️';
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
  });

  it('вход длиннее блока (64+ байт) — как node:crypto', () => {
    const s = 'a'.repeat(1000);
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
  });
});

describe('hmacSha256Hex', () => {
  it('RFC 4231, случай 1: ключ 0x0b×20, данные «Hi There»', () => {
    expect(hmacSha256Hex('\x0b'.repeat(20), 'Hi There')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('RFC 4231, случай 2: ключ «Jefe»', () => {
    expect(
      hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
    ).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('ключ длиннее блока (131 байт) — хэшируется первым, как node:crypto', () => {
    // RFC 4231 случай 6 оперирует сырыми байтами 0xaa — в JS-строке это
    // другой UTF-8-хвост, поэтому сверяем эталон с node:crypto, а не константой
    const key = 'k'.repeat(131);
    const message = 'Test Using Larger Than Block-Size Key - Hash Key First';
    expect(hmacSha256Hex(key, message)).toBe(
      createHmac('sha256', key).update(message).digest('hex'),
    );
  });

  it('случайные входы — неотличимо от node:crypto', () => {
    for (let i = 0; i < 25; i++) {
      const key = Math.random().toString(36).slice(2) + 'k'.repeat(i);
      const message = Math.random().toString(36).slice(2) + 'm'.repeat(i * 3);
      expect(hmacSha256Hex(key, message)).toBe(
        createHmac('sha256', key).update(message).digest('hex'),
      );
    }
  });
});
