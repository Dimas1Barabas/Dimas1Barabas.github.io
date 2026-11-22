import {
  CircuitBreaker,
  ExternalMoviesClient,
  ExternalMoviesUnavailableError,
  normalizeTitle,
  type FetchLike,
  type ResponseLike,
} from './external-movies.client';
import type { EnrichmentConfig } from './enrichment.config';

/** успешный JSON-ответ справочника */
const jsonRes = (body: unknown, status = 200): ResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

/** байтовый ответ (постер) */
const bytesRes = (
  bytes: Uint8Array,
  contentType: string,
  status = 200,
): ResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => (name === 'content-type' ? contentType : null) },
  json: async () => {
    throw new Error('не JSON');
  },
  arrayBuffer: async () =>
    bytes.slice().buffer as ArrayBuffer,
});

/** fetch-фейк: помнит вызовы, раздаёт ответы по очереди/правилу */
function fakeFetch(handler: (url: string, call: number) => Promise<ResponseLike>) {
  let calls = 0;
  const urls: string[] = [];
  const impl: FetchLike = (url) => {
    urls.push(url);
    calls += 1;
    return handler(url, calls);
  };
  return { impl, get callCount() { return calls; }, urls };
}

const record = (over: Record<string, unknown> = {}) => ({
  title: 'Млечный Путь: Операция «Туманность»',
  year: 2025,
  rating: 8.3,
  votes: 120_450,
  genres: ['фантастика', 'драма'],
  country: 'Россия',
  director: 'А. Режиссёр',
  actors: ['И. Актёр', 'Е. Актриса'],
  ageRating: '16+',
  trailerUrl: 'https://trailers.example/milky-way',
  posterUrl: 'http://kinoapi:8100/posters/milky-way.png',
  ...over,
});

/** конфиг с маленькими ретраями/breaker'ом — спекам не нужны прод-числа */
const cfg = (over: Partial<EnrichmentConfig> = {}): EnrichmentConfig => ({
  baseUrl: 'http://kinoapi:8100',
  timeoutMs: 200,
  retries: 2,
  breakerThreshold: 3,
  breakerCooldownMs: 1000,
  posterMaxBytes: 2 * 1024 * 1024,
  ...over,
});

/** клиент с мгновенным sleep и управляемыми часами breaker'а */
function buildClient(
  fetchImpl: FetchLike,
  over: Partial<EnrichmentConfig> = {},
) {
  let clock = 0;
  const client = new ExternalMoviesClient(cfg(over), {
    fetchImpl,
    sleep: async () => undefined,
    now: () => clock,
  });
  return {
    client,
    /** перемотать часы breaker'а вперёд */
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('normalizeTitle', () => {
  it('приводит регистр, пробелы и ё', () => {
    expect(normalizeTitle('  Ёлкин   КОТ   ')).toBe('елкин кот');
  });
});

describe('CircuitBreaker', () => {
  it('закрыт до порога, открыт после, полупроба после кулдауна', () => {
    let clock = 0;
    const breaker = new CircuitBreaker(2, 1000, () => clock);
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.allows()).toBe(false);
    clock += 999;
    expect(breaker.state).toBe('open');
    clock += 1;
    expect(breaker.state).toBe('half-open');
    expect(breaker.allows()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.failureCount).toBe(0);
  });

  it('провал полупробы открывает цепь на полный кулдаун заново', () => {
    let clock = 0;
    const breaker = new CircuitBreaker(1, 1000, () => clock);
    breaker.recordFailure();
    clock += 1000;
    expect(breaker.state).toBe('half-open');
    breaker.recordFailure(); // проба провалилась
    expect(breaker.state).toBe('open'); // не half-open сразу после провала
    expect(breaker.allows()).toBe(false);
    clock += 999;
    expect(breaker.state).toBe('open'); // кулдаун пошёл заново
    clock += 1;
    expect(breaker.state).toBe('half-open');
  });
});

describe('ExternalMoviesClient.findByTitle', () => {
  it('отдаёт лучшее совпадение: точное бьёт вложенное', async () => {
    const fetch = fakeFetch(async () =>
      jsonRes({
        items: [record({ title: 'Млечный Путь: Операция «Туманность»' }), record({ title: 'Млечный Путь' })],
      }),
    );
    const { client } = buildClient(fetch.impl);
    const found = await client.findByTitle('Млечный Путь: Операция «Туманность»');
    expect(found?.title).toBe('Млечный Путь: Операция «Туманность»');
    expect(found?.rating).toBe(8.3);
    // название уезжает в query, не в путь
    expect(fetch.urls[0]).toContain(
      `/v1/movies/search?title=${encodeURIComponent('Млечный Путь: Операция «Туманность»')}`,
    );
  });

  it('ищет без учёта регистра и ё, с двойными пробелами', async () => {
    const fetch = fakeFetch(async () =>
      jsonRes({ items: [record({ title: 'Ёлкин кот' })] }),
    );
    const { client } = buildClient(fetch.impl);
    const found = await client.findByTitle('  ЕЛКИН   КОТ  ');
    expect(found?.title).toBe('Ёлкин кот');
  });

  it('нет совпадений или пустой список — null без ошибок', async () => {
    const fetch = fakeFetch(async () => jsonRes({ items: [] }));
    const { client } = buildClient(fetch.impl);
    expect(await client.findByTitle('Неизвестный фильм')).toBeNull();
    const fetch2 = fakeFetch(async () =>
      jsonRes({ items: [record({ title: 'Совсем другое кино' })] }),
    );
    const { client: client2 } = buildClient(fetch2.impl);
    expect(await client2.findByTitle('Третье кино')).toBeNull();
  });

  it('мусорные записи отфильтрованы, неполные — с дефолтами', async () => {
    const fetch = fakeFetch(async () =>
      jsonRes({
        items: [
          { year: 'не число', genres: ['триллер', 42, null], title: 'Голая запись' },
          { nope: true },
          'строка вообще',
        ],
      }),
    );
    const { client } = buildClient(fetch.impl);
    const found = await client.findByTitle('Голая запись');
    expect(found).toEqual({
      title: 'Голая запись',
      year: 0,
      rating: 0,
      votes: 0,
      genres: ['триллер'],
      country: '',
      director: '',
      actors: [],
      ageRating: '',
      trailerUrl: '',
      posterUrl: '',
    });
  });

  it('5xx ретраится и после исчерпания считает неудачу breaker’а', async () => {
    const fetch = fakeFetch(async () => jsonRes({ items: [] }, 503));
    const { client } = buildClient(fetch.impl);
    await expect(client.findByTitle('Что угодно')).rejects.toBeInstanceOf(
      ExternalMoviesUnavailableError,
    );
    expect(fetch.callCount).toBe(3); // 1 + 2 ретрая
    expect(client.breaker.failureCount).toBe(1);
  });

  it('500 за первым идёт 200 — успех на ретрае сбрасывает счётчик', async () => {
    const fetch = fakeFetch(async (_url, call) =>
      call === 1 ? jsonRes({ items: [] }, 500) : jsonRes({ items: [record()] }),
    );
    const { client } = buildClient(fetch.impl);
    const found = await client.findByTitle('Млечный Путь: Операция «Туманность»');
    expect(found).not.toBeNull();
    expect(client.breaker.failureCount).toBe(0);
  });

  it('429 ретраебелен, как и пятисотые', async () => {
    const fetch = fakeFetch(async (_url, call) =>
      call === 1 ? jsonRes({ items: [] }, 429) : jsonRes({ items: [record()] }),
    );
    const { client } = buildClient(fetch.impl);
    expect(await client.findByTitle('Млечный Путь')).not.toBeNull();
  });

  it('прочие 4xx — без ретраев и без счёта breaker’у', async () => {
    const fetch = fakeFetch(async () => jsonRes({ items: [] }, 401));
    const { client } = buildClient(fetch.impl);
    await expect(client.findByTitle('Млечный Путь')).rejects.toThrow(
      /HTTP 401/,
    );
    expect(fetch.callCount).toBe(1);
    expect(client.breaker.failureCount).toBe(0);
  });

  it('таймаут убивает попытку — причина видна в сообщении', async () => {
    // «висящий» справочник: ответ никогда не приходит, единственный путь
    // наружу — abort от AbortController по таймауту (как у реального fetch)
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const { client } = buildClient(hanging, { timeoutMs: 20 });
    await expect(client.findByTitle('Млечный Путь')).rejects.toThrow(
      /таймаут 20 мс/,
    );
    // все попытки исчерпаны — неудача пошла breaker'у
    expect(client.breaker.failureCount).toBe(1);
  });

  it('breaker открыт — вызов отпихивается БЕЗ похода в сеть', async () => {
    const fetch = fakeFetch(async () => jsonRes({ items: [] }, 503));
    const { client } = buildClient(fetch.impl, { breakerThreshold: 2 });
    for (let i = 0; i < 2; i++) {
      await expect(client.findByTitle('Млечный Путь')).rejects.toBeInstanceOf(
        ExternalMoviesUnavailableError,
      );
    }
    expect(client.breakerState).toBe('open');
    const callsBefore = fetch.callCount;
    await expect(client.findByTitle('Млечный Путь')).rejects.toThrow(/breaker/);
    expect(fetch.callCount).toBe(callsBefore); // сеть не трогали
  });

  it('после кулдауна полупроба: успех закрывает цепь', async () => {
    let mode: 'down' | 'up' = 'down';
    const fetch = fakeFetch(async () =>
      mode === 'down' ? jsonRes({ items: [] }, 503) : jsonRes({ items: [record()] }),
    );
    const { client, advance } = buildClient(fetch.impl, {
      breakerThreshold: 2,
      breakerCooldownMs: 1000,
    });
    for (let i = 0; i < 2; i++) {
      await expect(client.findByTitle('Млечный Путь')).rejects.toBeInstanceOf(
        ExternalMoviesUnavailableError,
      );
    }
    advance(1000);
    expect(client.breakerState).toBe('half-open');
    mode = 'up';
    expect(await client.findByTitle('Млечный Путь')).not.toBeNull();
    expect(client.breakerState).toBe('closed');
  });

  it('полупроба провалилась — цепь открыта на полный кулдаун снова', async () => {
    const fetch = fakeFetch(async () => jsonRes({ items: [] }, 503));
    const { client, advance } = buildClient(fetch.impl, {
      breakerThreshold: 1,
      breakerCooldownMs: 1000,
    });
    await expect(client.findByTitle('Млечный Путь')).rejects.toBeInstanceOf(
      ExternalMoviesUnavailableError,
    );
    advance(1000); // half-open
    const callsAtProbe = fetch.callCount;
    await expect(client.findByTitle('Млечный Путь')).rejects.toBeInstanceOf(
      ExternalMoviesUnavailableError,
    );
    expect(fetch.callCount).toBe(callsAtProbe + 3); // проба + её ретраи
    expect(client.breakerState).toBe('open'); // не half-open
    await expect(client.findByTitle('Млечный Путь')).rejects.toThrow(/breaker/);
  });
});

describe('ExternalMoviesClient.fetchPoster', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

  it('отдаёт байты с честным Content-Type', async () => {
    const fetch = fakeFetch(async () => bytesRes(png, 'image/png'));
    const { client } = buildClient(fetch.impl);
    const poster = await client.fetchPoster('http://kinoapi:8100/posters/x.png');
    expect(poster?.contentType).toBe('image/png');
    expect(Array.from(poster?.buffer ?? [])).toEqual(Array.from(png));
  });

  it('чужой Content-Type, не-http ссылка и oversized — null', async () => {
    const big = new Uint8Array(3 * 1024 * 1024);
    const fetch = fakeFetch(async (_url, call) => {
      if (call === 1) return bytesRes(png, 'text/html'); // не картинка
      if (call === 2) return bytesRes(big, 'image/png'); // больше потолка
      return bytesRes(png, 'image/png');
    });
    const { client } = buildClient(fetch.impl, { posterMaxBytes: 2 * 1024 * 1024 });
    expect(await client.fetchPoster('http://kinoapi:8100/p/1.png')).toBeNull();
    expect(await client.fetchPoster('http://kinoapi:8100/p/2.png')).toBeNull();
    expect(await client.fetchPoster('ftp://kinoapi:8100/p/3.png')).toBeNull();
    expect(fetch.callCount).toBe(2); // ftp даже не ходил в fetch
  });

  it('сеть умерла — null, breaker не тронут (постер — опция)', async () => {
    const fetch = fakeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { client } = buildClient(fetch.impl);
    expect(await client.fetchPoster('http://kinoapi:8100/p/x.png')).toBeNull();
    expect(client.breaker.failureCount).toBe(0);
  });
});
