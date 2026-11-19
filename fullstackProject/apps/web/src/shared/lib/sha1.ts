/**
 * SHA-1 и HMAC-SHA1 — синхронно и без зависимостей.
 *
 * Зачем своя реализация: TOTP (RFC 6238) живёт на HMAC-SHA1, а браузерный
 * crypto.subtle — только async; демо-движок считает коды синхронно, как
 * node:crypto в API. Спек сверяет с node:crypto (векторы FIPS 180-1 и
 * RFC 2202) — эталон один на оба мира, как у sha256.
 */

function rol(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** голый SHA-1 над байтами (RFC 3174) — строительный блок для HMAC */
export function sha1Bytes(input: Uint8Array): Uint8Array {
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  // паддинг: 0x80, нули, длина в битах big-endian (uint64)
  const bitLen = input.length * 8;
  const padded = new Uint8Array(((input.length + 8 >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  // тип .buffer — ArrayBufferLike (TS 5.7), DataView нужен именно ArrayBuffer
  const dv = new DataView(padded.buffer as ArrayBuffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x1_0000_0000), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);

  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rol(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer as ArrayBuffer);
  odv.setUint32(0, h0, false);
  odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false);
  return out;
}

export function sha1Hex(message: string): string {
  const bytes = sha1Bytes(new TextEncoder().encode(message));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * HMAC-SHA1 (RFC 2104): ключ длиннее блока (64 байта) сперва
 * хэшируется, затем ipad/opad — как в эталонной схеме.
 */
export function hmacSha1Bytes(key: Uint8Array, message: Uint8Array): Uint8Array {
  let keyBytes = key;
  if (keyBytes.length > 64) {
    keyBytes = sha1Bytes(keyBytes);
  }
  const iKey = new Uint8Array(64);
  const oKey = new Uint8Array(64);
  iKey.set(keyBytes);
  oKey.set(keyBytes);
  for (let i = 0; i < 64; i++) {
    iKey[i] ^= 0x36;
    oKey[i] ^= 0x5c;
  }

  const inner = new Uint8Array(64 + message.length);
  inner.set(iKey);
  inner.set(message, 64);
  const innerHash = sha1Bytes(inner);

  const outer = new Uint8Array(64 + 20);
  outer.set(oKey);
  outer.set(innerHash, 64);
  return sha1Bytes(outer);
}
