/**
 * Мок партнёра-получателя вебхуков (этап 39). В стенде и CI играет
 * роль чужого HTTPS-ендпоинта, на который «Почтальон» доставляет
 * события брони: принимает конверты, копит статистику и хранит
 * последние принятые тела вместе с заголовками подписи — e2e
 * проверяет HMAC тем же алгоритмом, что и настоящий партнёр.
 * Один файл без зависимостей — только node:http.
 *
 * Ручки:
 *   POST /sink                 — принять вебхук (200, тело сохраняется)
 *   GET  /__stats              — счётчики и последние конверты
 *   POST /__chaos {"mode":…}   — режим отказов приёмника
 *   GET  /health               — живость (НЕ зависит от chaos-режима:
 *                                healthcheck стенда остаётся зелёным)
 *
 * Режимы отказов действуют только на /sink:
 *   ok   — принимаем (дефолт)
 *   500  — пятисотит: доставки копят попытки и умирают в DLQ
 *   off  — рвёт соединение без ответа (симуляция мёртвого партнёра)
 */
const http = require('node:http');

const PORT = Number(process.env.PORT || 8103);
const KEEP = 25; // сколько последних конвертов держать для /__stats

/** режим отказов приёмника: ok | 500 | off */
let chaos = 'ok';

/** последние принятые конверты: тело + служебные заголовки подписи */
const inbox = [];

/** счётчики по ручкам */
const stats = { sink: 0, sinkFailed: 0, chaos: 0 };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mode: chaos }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/__chaos') {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let mode = 'ok';
      try {
        mode = JSON.parse(body).mode || 'ok';
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'тело не JSON' }));
        return;
      }
      if (!['ok', '500', 'off'].includes(mode)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `неизвестный режим ${mode}` }));
        return;
      }
      chaos = mode;
      stats.chaos++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode: chaos }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode: chaos, stats, inbox }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/sink') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      if (chaos === 'off') {
        // мёртвый партнёр: рвём соединение без ответа
        req.destroy();
        return;
      }
      if (chaos === '500') {
        stats.sinkFailed++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'chaos: приёмник пятисотит' }));
        return;
      }
      stats.sink++;
      const body = Buffer.concat(parts).toString('utf8');
      inbox.push({
        body,
        signature: req.headers['x-cb-signature'] || null,
        timestamp: req.headers['x-cb-timestamp'] || null,
        event: req.headers['x-cb-event'] || null,
        delivery: req.headers['x-cb-delivery'] || null,
        receivedAt: new Date().toISOString(),
      });
      if (inbox.length > KEEP) inbox.shift();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: `нет ручки ${req.method} ${url.pathname}` }));
});

server.listen(PORT, () => {
  console.log(`partnerhooks-мок слушает :${PORT}, режим приёмника: ok`);
});
