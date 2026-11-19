import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha1Bytes, sha1Bytes, sha1Hex } from './sha1';

/**
 * Векторы FIPS 180-1 / RFC 3174 и RFC 2202 (HMAC-SHA1), плюс сверка
 * с node:crypto на случайных входах — эталон один на браузер и API.
 */

const hex = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('sha1: векторы FIPS 180-1', () => {
  it('пустая строка', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('«abc»', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('сообщение 448 бит (граница паддинга)', () => {
    expect(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    );
  });

  it('сообщение 896 бит (два блока)', () => {
    expect(
      sha1Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('a49b2446a02c645bf419f995b67091253a04a259');
  });
});

describe('sha1: сверка с node:crypto на случайных входах', () => {
  it('байтовые строки разной длины — включая границы блоков', () => {
    const lengths = [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000];
    for (const len of lengths) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 91) % 256);
      const expected = createHash('sha1').update(bytes).digest('hex');
      expect(hex(sha1Bytes(bytes))).toBe(expected);
    }
  });
});

describe('hmacSha1: векторы RFC 2202', () => {
  it('случай 2: ключ «Jefe»', () => {
    const mac = hmacSha1Bytes(
      new TextEncoder().encode('Jefe'),
      new TextEncoder().encode('what do ya want for nothing?'),
    );
    expect(hex(mac)).toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
  });

  it('случай 1: ключ 0x0b×20, «Hi There»', () => {
    const mac = hmacSha1Bytes(
      Uint8Array.from({ length: 20 }, () => 0x0b),
      new TextEncoder().encode('Hi There'),
    );
    expect(hex(mac)).toBe('b617318655057264e28bc0b6fb378c8ef146be00');
  });

  it('ключ длиннее блока хэшируется (случай 6: 0xaa×80)', () => {
    const mac = hmacSha1Bytes(
      Uint8Array.from({ length: 80 }, () => 0xaa),
      new TextEncoder().encode(
        'Test Using Larger Than Block-Size Key - Hash Key First',
      ),
    );
    expect(hex(mac)).toBe('aa4ae5e15272d00e95705637ce8a3b55ed402112');
  });

  it('ключ 131 байт — как node:crypto (размер из RFC 4231)', () => {
    const key = Uint8Array.from({ length: 131 }, () => 0xaa);
    const msg = new TextEncoder().encode(
      'Test Using Larger Than Block-Size Key - Hash Key First',
    );
    expect(hex(hmacSha1Bytes(key, msg))).toBe(
      createHmac('sha1', key).update(msg).digest('hex'),
    );
  });

  it('сверка с node:crypto на случайных ключах и сообщениях', () => {
    for (let i = 0; i < 5; i++) {
      const key = Uint8Array.from({ length: 1 + i * 23 }, (_, j) => (j * 7 + i) % 256);
      const msg = Uint8Array.from({ length: 3 + i * 40 }, (_, j) => (j * 13 + i) % 256);
      const expected = createHmac('sha1', key).update(msg).digest('hex');
      expect(hex(hmacSha1Bytes(key, msg))).toBe(expected);
    }
  });
});
