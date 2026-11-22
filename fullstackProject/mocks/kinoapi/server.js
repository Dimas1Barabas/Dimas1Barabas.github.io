/**
 * Мок внешнего кино-справочника (этап 37). В стенде и CI играет роль
 * чужого HTTP-API, из которого афиша подтягивает метаданные: рейтинг,
 * год, жанры, трейлер, постер. Один файл без зависимостей — только
 * node:http и node:zlib (PNG-постеры собираем сами, чтобы не тащить
 * бинарники в репозиторий).
 *
 * Ручки:
 *   GET  /v1/movies/search?title=…  — поиск по нормализованному названию
 *   GET  /posters/:slug             — PNG-постер (цвет детерминирован слагом)
 *   GET  /health                    — живость (НЕ зависит от chaos-режима:
 *                                     healthcheck стенда должен оставаться
 *                                     зелёным, ломаем только бизнес-ручки)
 *   POST /__chaos {"mode":…}        — режим отказов: ok | slow | 500 | 429 | off
 *   GET  /__stats                   — счётчики запросов (e2e доказывает
 *                                     breaker: «вверх не ходили»)
 *
 * Режимы отказов действуют на /v1/* и /posters/*:
 *   ok    — нормальные ответы (дефолт)
 *   slow  — задержка ?ms (по умолчанию 5000) до честного ответа — клиент
 *           должен успеть отвалиться по своему таймауту
 *   500   — пятисотит всем бизнес-ручкам
 *   429   — «слишком часто» всем бизнес-ручкам
 *   off   — рвёт соединение без ответа (симуляция мёртвого апстрима)
 */
const http = require('node:http');
const zlib = require('node:zlib');

// ---------------------------------------------------------------- каталог

/** слаг = ключ постера; названия совпадают с сидами афиши */
const CATALOG = [
  {
    slug: 'milky-way-nebula',
    title: 'Млечный Путь: Операция «Туманность»',
    year: 2025,
    rating: 8.3,
    votes: 120450,
    genres: ['фантастика', 'драма'],
    country: 'Россия',
    director: 'А. Режиссёр',
    actors: ['И. Актёр', 'Е. Актриса', 'Ю. Второйплан'],
    ageRating: '16+',
    trailerUrl: 'https://trailers.example/milky-way-nebula',
  },
  {
    slug: 'last-debug',
    title: 'Последний дебаг',
    year: 2024,
    rating: 7.1,
    votes: 42100,
    genres: ['триллер', 'детектив'],
    country: 'Россия',
    director: 'Б. Постановщик',
    actors: ['Д. Джуниор', 'С. Сеньор'],
    ageRating: '12+',
    trailerUrl: 'https://trailers.example/last-debug',
  },
  {
    slug: 'madame-cache',
    title: 'Госпожа Кэш',
    year: 2023,
    rating: 6.8,
    votes: 8902,
    genres: ['драма'],
    country: 'Россия',
    director: 'В. Мастер',
    actors: ['О. Богатая', 'Н. Незнакомец'],
    ageRating: '16+',
    trailerUrl: 'https://trailers.example/madame-cache',
  },
  {
    slug: 'recursion',
    title: 'Рекурсия',
    year: 2025,
    rating: 7.9,
    votes: 65300,
    genres: ['хоррор', 'фантастика'],
    country: 'Россия',
    director: 'А. Режиссёр',
    actors: ['Ф. Функция', 'Б. Базовыйслучай'],
    ageRating: '18+',
    trailerUrl: 'https://trailers.example/recursion',
  },
  {
    slug: 'old-repo-secret',
    title: 'Тайна старого репозитория',
    year: 2022,
    rating: 7.4,
    votes: 15800,
    genres: ['приключения'],
    country: 'Россия',
    director: 'Г. Археологов',
    actors: ['Л. Легаси', 'К. Коммитов'],
    ageRating: '6+',
    trailerUrl: 'https://trailers.example/old-repo-secret',
  },
  {
    slug: 'forty-ninth-stream',
    title: 'Сорок девятый поток',
    year: 2026,
    rating: 8.9,
    votes: 2340,
    genres: ['документальный'],
    country: 'Россия',
    director: 'Х. Документов',
    actors: ['Курс 49-й', 'Куратор 49-й'],
    ageRating: '12+',
    trailerUrl: 'https://trailers.example/forty-ninth-stream',
  },
  // кино, которого нет в афише: поиск по обрывку названия должен находить
  // и его — клиент обязан выбрать ЛУЧШЕЕ совпадение, а не первое попавшееся
  {
    slug: 'milky-way-origins',
    title: 'Млечный Путь: Истоки',
    year: 2019,
    rating: 7.0,
    votes: 9000,
    genres: ['фантастика'],
    country: 'Россия',
    director: 'А. Режиссёр',
    actors: ['И. Актёр'],
    ageRating: '16+',
    trailerUrl: 'https://trailers.example/milky-way-origins',
  },
];

// ------------------------------------------------------------- PNG-энкодер

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/** сплошной PNG WxH заданного цвета — «постер» без единой зависимости */
function solidPng(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // фильтр None
    for (let x = 0; x < w; x++) {
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 2; // цвет Truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** цвет постера детерминирован слагом: тот же слаг — тот же цвет */
function slugColor(slug) {
  let hash = 0;
  for (const ch of slug) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffff;
  return [(hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff];
}

const POSTERS = new Map(
  CATALOG.map((m) => [m.slug, solidPng(96, 144, slugColor(m.slug))]),
);

// ------------------------------------------------------------------ поиск

/** нормализация как у клиента API: регистр, пробелы, ё -> е */
function normalizeTitle(t) {
  return String(t)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function search(query, origin) {
  const q = normalizeTitle(query);
  if (!q) return [];
  const scored = [];
  for (const m of CATALOG) {
    const t = normalizeTitle(m.title);
    let score = 0;
    if (t === q) score = 4;
    else if (t.startsWith(q) || q.startsWith(t)) score = 3;
    else if (t.includes(q) || q.includes(t)) score = 2;
    if (score > 0) scored.push({ score, m });
  }
  scored.sort((a, b) => b.score - a.score);
  // абсолютный URL из Host запроса: клиент API увидит нас как kinoapi:8100
  return scored.map(({ m }) => ({
    ...m,
    posterUrl: `${origin}/posters/${m.slug}`,
  }));
}

// ---------------------------------------------------------------- сервер

/** режим отказов бизнес-ручек; /health всегда живой */
let chaos = { mode: 'ok', ms: 5000 };
const stats = { search: 0, poster: 0, chaosHits: 0 };

const CHAOS_MODES = new Set(['ok', 'slow', '500', '429', 'off']);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    return sendJson(res, 200, { ok: true, mode: chaos.mode });
  }

  if (req.method === 'POST' && path === '/__chaos') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!CHAOS_MODES.has(parsed.mode)) {
          return sendJson(res, 400, { error: `неизвестный режим: ${parsed.mode}` });
        }
        chaos = { mode: parsed.mode, ms: Number(parsed.ms) || 5000 };
        sendJson(res, 200, { mode: chaos.mode, ms: chaos.ms });
      } catch {
        sendJson(res, 400, { error: 'битый JSON' });
      }
    });
    return;
  }

  if (req.method === 'GET' && path === '/__stats') {
    return sendJson(res, 200, { ...stats, mode: chaos.mode });
  }

  // бизнес-ручки: применяем chaos-режим
  const serve = () => {
    if (req.method === 'GET' && path === '/v1/movies/search') {
      stats.search += 1;
      const q = url.searchParams.get('title') ?? '';
      const origin = `http://${req.headers.host ?? 'localhost:8100'}`;
      return sendJson(res, 200, { items: search(q, origin) });
    }
    const poster = /^\/posters\/([a-z0-9-]+)(?:\.png)?$/.exec(path);
    if (req.method === 'GET' && poster) {
      stats.poster += 1;
      const png = POSTERS.get(poster[1]);
      if (!png) return sendJson(res, 404, { error: 'нет такого постера' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    sendJson(res, 404, { error: `нет маршрута ${req.method} ${path}` });
  };

  if (chaos.mode === 'ok') return serve();
  stats.chaosHits += 1;
  if (chaos.mode === '500') return sendJson(res, 500, { error: 'internal' });
  if (chaos.mode === '429') return sendJson(res, 429, { error: 'too many requests' });
  if (chaos.mode === 'off') return res.destroy(); // без ответа — «апстрим умер»
  // slow: честный ответ, но с задержкой — клиент должен уйти по таймауту
  setTimeout(serve, chaos.ms);
});

const PORT = Number(process.env.PORT) || 8100;
server.listen(PORT, () => {
  console.log(`kinoapi-мок слушает :${PORT}, фильмов в справочнике: ${CATALOG.length}`);
});
