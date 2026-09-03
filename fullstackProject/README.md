# CineBooking — фулстек-демо: бронирование билетов в кино

Монорепозиторий с полным циклом асинхронной обработки брони:

```
┌──────────┐  REST   ┌────────────┐        ┌──────────────┐
│ Vue 3 SPA│ ──────▶ │ NestJS API │ ◀─────▶ │ PostgreSQL   │
│ (Vite)   │ ◀────── │ (TypeORM)  │        └──────────────┘
└──────────┘         │      │     │        ┌──────────────┐
                     │      ├─────┼─────▶  │ Redis (кэш)  │
                     │      │     │        └──────────────┘
              publish│      │consume
              booking.created │ booking.processed
                     ▼      ▲
              ┌─────────────────┐
              │ RabbitMQ        │   topic-обмен «cinema»
              └────────┬────────┘
                       │ consume
                       ▼
              ┌─────────────────┐
              │ Go ticket-worker│  «платёжный шлюз» + /stats
              └─────────────────┘
```

**Живая демка (демо-режим без бэкенда):**
<https://dimas1barabas.github.io/CineBooking/>

## Быстрый старт (всё в docker)

```bash
docker compose up --build
```

| Сервис | Адрес | Примечание |
|---|---|---|
| web (SPA) | http://localhost:18080 | nginx, /api → api |
| api (NestJS) | http://localhost:13000/api/health | health-check трёх зависимостей |
| RabbitMQ UI | http://localhost:15672 | guest / guest |
| worker (Go) | http://localhost:8081/stats | счётчики обработанных броней |
| PostgreSQL | localhost:15432 | cine / cine, БД cine |
| Redis | localhost:6379 | кэш фильмов, TTL 60 c |

Host-порты 13000/15432/18080 выбраны, чтобы не конфликтовать
с типичными локальными сервисами (3000/5432/8080).

При первом старте API сеет 6 фильмов в Postgres (если таблица пуста).

## Разработка без docker (только инфраструктура в docker)

```bash
docker compose up -d postgres redis rabbitmq

# API (порт задаётся через PORT, если 3000 занят)
cd apps/api
npm install
PORT=13000 npm run start:dev   # http://localhost:13000/api

# Web (в отдельном терминале)
cd apps/web
npm install
npm run dev              # http://localhost:5173 (прокси /api → :13000)

# Go-воркер
cd services/ticket-worker
go run .                 # слушает RabbitMQ, /stats на :8081
```

## Тесты

Три уровня, фронт и бэк:

```bash
# фронт: vitest (24 теста) — форматтеры, демо-движок, сторы pinia, компоненты
cd apps/web && npm test

# API: юнит (20 тестов) — логика брони, кэш, health
cd apps/api && npm test

# API: интеграционные (10) — полный HTTP-стек Nest (роутинг, ValidationPipe,
# контроллеры → сервисы → фейковые Postgres/RabbitMQ/Redis на Map)
cd apps/api && npm run test:integration

# API: e2e против живого docker-стенда (health, кэш, полный цикл с Go-воркером;
# если стек не поднят — корректно пропускается с предупреждением)
cd apps/api && npm run test:e2e
```

База стенда для e2e переопределяется через `E2E_BASE_URL` (по умолчанию
`http://localhost:13000/api`).

## Как устроено

### Поток бронирования

1. `GET /api/movies` — SPA получает сеансы. Ответ помечен источником:
   при попадании в Redis-кэш (`movies:all`, TTL 60 c) список не ходит в
   Postgres — во фронтенде это видно по бейджу «из кэша».
2. `POST /api/bookings {movieId, customerName, seats}` — бронь сохраняется
   в Postgres со статусом `PENDING` и мгновенно возвращается клиенту.
3. API публикует `booking.created` в topic-обмен `cinema` (RabbitMQ).
4. Go-воркер `ticket-worker` консьюмит `worker.booking.created`
   (prefetch = 1), имитирует оплату 1,2–2,8 с с вероятностью успеха ~90%,
   публикует `booking.processed` с вердиктом, рядом/местами и своим именем.
5. NestJS слушает `api.booking.processed` и обновляет бронь в Postgres:
   `CONFIRMED`/`FAILED` + сообщение от воркера.
6. SPA опрашивает `GET /api/bookings` каждые 3 c — статус меняется на глазах.

### Каталоги

```
apps/
  api/            NestJS 11: REST, TypeORM, ioredis, @golevelup/nestjs-rabbitmq
  web/            Vue 3 + Vite + Pinia; nginx для docker; демо-режим
services/
  ticket-worker/  Go: консьюмер, реконнекты, ack/nack, /health /stats
```

### Демо-режим на GitHub Pages

Pages раздаёт только статику, поэтому опубликованная сборка при
недоступном API прозрачно переключается на локальную симуляцию:
те же события, тайминги и вероятности, что у Go-воркера (баннер
«демо-режим» в интерфейсе). Собранная страница живёт в `CineBooking/`
в корне репозитория; пересборка:

```bash
cd apps/web && npm run build
rm -rf ../../CineBooking && cp -r dist ../../CineBooking
```

## Переменные окружения

См. [.env.example](.env.example). В docker compose всё уже настроено.

## Заметки

- `synchronize: true` у TypeORM оставлен для простоты демо; для продакшена —
  миграции (`TYPEORM_SYNCHRONIZE=false`).
- Обмен `cinema` объявляют и API, и воркер одинаковыми параметрами —
  кто стартует первым, тот и создаёт.
