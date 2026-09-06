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
| worker (Go) | http://localhost:8081/stats | счётчики оплат и возвратов |
| PostgreSQL | localhost:15432 | cine / cine, БД cine |
| Redis | localhost:6379 | кэш фильмов, TTL 60 c |

Host-порты 13000/15432/18080 выбраны, чтобы не конфликтовать
с типичными локальными сервисами (3000/5432/8080).

При первом старте API применяет SQL-миграции (TypeORM, `apps/api/src/migrations`)
и сеет 6 фильмов в Postgres (если таблица пуста).

## Разработка без docker (только инфраструктура в docker)

```bash
docker compose up -d postgres redis rabbitmq

# API (порт задаётся через PORT, если 3000 занят)
cd apps/api
npm install
PORT=13000 npm run start:dev   # http://localhost:13000/api
# схема применяется миграциями автоматически при старте

# Web (в отдельном терминале)
cd apps/web
npm install
npm run dev              # http://localhost:5173 (прокси /api → :13000)

# Go-воркер
cd services/ticket-worker
go run .                 # слушает RabbitMQ, /stats на :8081
```

### Миграции

Схему БД создают и меняют только миграции (`synchronize` убран) —
журнал в таблице `migrations`. Приложение применяет их автоматически
при старте (`migrationsRun: true`), руками — из `apps/api`:

```bash
npm run migration:show      # что применено / в ожидании
npm run migration:run       # применить ожидающие
npm run migration:revert    # откатить последнюю

# новая миграция: diff «сущности ↔ БД». Генерить нужно против ПУСТОЙ БД,
# иначе diff с уже собранной synchronize-схемой будет пуст:
docker compose exec postgres createdb -U cine cine_empty
DATABASE_URL=postgres://cine:cine@localhost:15432/cine_empty \
  npm run migration:generate -- src/migrations/AddSomething
docker compose exec postgres dropdb -U cine cine_empty
```

Файлы миграций лежат в `apps/api/src/migrations` и попадают в docker-образ
вместе с `dist` без правок Dockerfile.

## Тесты

Три уровня, фронт и бэк:

```bash
# фронт: vitest (47 тестов) — форматтеры, зал, демо-движок, сторы pinia
# (включая auth-сессию), компоненты
cd apps/web && npm test

# API: юнит (56 тестов) — логика брони, места/конфликт, отмена/возврат,
# SSE, кэш, health, пользователи/посев админа, JWT-логин
cd apps/api && npm test

# API: интеграционные (41) — полный HTTP-стек Nest (роутинг, ValidationPipe,
# контроллеры → сервисы → фейковые Postgres/RabbitMQ/Redis на Map),
# включая 409-конфликт мест, сагу отмены, SSE-стрим по живому HTTP,
# регистрацию/логин и guard'ы (401/403/роли)
cd apps/api && npm run test:integration

# API: e2e против живого docker-стенда (health, кэш, полный цикл с Go-воркером;
# если стек не поднят — корректно пропускается с предупреждением)
cd apps/api && npm run test:e2e
```

База стенда для e2e переопределяется через `E2E_BASE_URL` (по умолчанию
`http://localhost:13000/api`).

Письменная тест-документация «как у QA» — в [docs/qa/](docs/qa/):
[тест-план](docs/qa/test-plan.md), [чек-листы](docs/qa/checklists.md),
[тест-кейсы](docs/qa/test-cases.md) (+ выгрузки [txt](docs/qa/test-cases.txt)
и [csv](docs/qa/test-cases.csv) в формате импорта TMS),
[матрица трассировки](docs/qa/traceability.md)
и [шаблон баг-репорта](docs/qa/bug-report-template.md).

## Как устроено

### Поток бронирования

1. `GET /api/movies` — SPA получает сеансы. Ответ помечен источником:
   при попадании в Redis-кэш (`movies:all`, TTL 60 c) список не ходит в
   Postgres — во фронтенде это видно по бейджу «из кэша».
2. `GET /api/movies/:id/seats` — карта занятости зала 8×10 (без кэша,
   всегда свежая) для сетки мест в модалке брони.
3. `POST /api/bookings {movieId, customerName, seats: ["5-7", "5-8"]}` —
   в одной транзакции сохраняется бронь `PENDING` и занимаются места.
   Арбитр в гонке за место — составной уникальный констрейнт
   `(movie_id, seat)` таблицы `seat_occupancy`: проигравший получает
   409 со списком занятых мест (`seatsTaken`).
4. API публикует `booking.created` в topic-обмен `cinema` (RabbitMQ).
5. Go-воркер `ticket-worker` консьюмит `worker.booking.created`
   (prefetch = 1), имитирует оплату 1,2–2,8 с с вероятностью успеха ~90%,
   публикует `booking.processed` с вердиктом, местами и своим именем.
6. NestJS слушает `api.booking.processed` и обновляет бронь в Postgres:
   `CONFIRMED`/`FAILED` + сообщение от воркера. При `FAILED` занятые
   места освобождаются — их снова можно купить.
7. SPA получает изменения мгновенно по Server-Sent Events:
   `GET /api/bookings/stream` (EventSource). Каждая мутация брони —
   create/cancel/processed/refunded — эмитит событие `booking` с самой
   бронью и свежей статистикой; каждые 25 c идёт heartbeat `ping`.
   При обрыве браузер переподключается сам, а по `onopen` фронт делает
   полный resync через `GET /bookings`. Опроса больше нет.

### Сага отмены (компенсация)

Подтверждённую бронь можно отменить — это отдельная асинхронная сага
с тем же воркером:

```
CONFIRMED ── POST /api/bookings/:id/cancel ──▶ CANCELLING
                          │ booking.cancelled (cinema)
                          ▼
                Go-воркер: «возврат платежа» 0,8–1,6 с (~90% успеха)
                          │ booking.refunded
          успех ◀─────────┴─────────▶ отказ (REFUND_FAILED)
            ▼                               ▼
CANCELLED + места свободны      бронь откатывается в CONFIRMED
```

- Переход `CONFIRMED → CANCELLING` — условный `UPDATE … WHERE status =
  'CONFIRMED'`: двойной клик по «Отменить» разрешается на стороне БД,
  проигравший получает 409 с текущим статусом.
- Места освобождаются **только после вердикта воркера** — если «банк»
  откажет в возврате, места остаются за клиентом, а бронь возвращается
  в `CONFIRMED` с сообщением об ошибке.
- Consumer `booking.refunded` идемпотентен: повторное событие (ределивери)
  по брони вне статуса `CANCELLING` пропускается.

### Авторизация (JWT + роли)

Витрина открыта всем, мутации — за Bearer-JWT:

- `POST /api/auth/register` — email + пароль (bcrypt на сервере) + имя;
  повторный email → 409 `emailTaken`.
- `POST /api/auth/login` — `{accessToken, user}`; токен живёт 2 ч,
  несёт `sub/email/name/role`, секрет — `JWT_SECRET`.
- Гварды по умолчанию закрывают всё (`deny by default`): `JwtAuthGuard`
  через `APP_GUARD`, открытые эндпоинты помечены `@Public()`
  (каталог, карта зала, статистика, SSE, health).
- `RolesGuard` следом сверяет роль с `@Roles(...)`: `POST /api/movies`
  (новый сеанс в афишу + сброс кэша каталога) — только админ.
- Бронь пишется на `user_id` из токена: имя покупателя берётся из профиля
  (поле `customerName` опционально), отменить чужую бронь нельзя (403).
- При старте API сеется админ (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, по умолчанию
  `admin@cine.local / admin-secret-1` — данные демонстрационные).
- SSE-стрим публичен осознанно: `EventSource` не умеет заголовок
  `Authorization`, а стрим — витринное демо-табло.
- На фронте: `/login` (вход и регистрация), токен в localStorage,
  `Authorization: Bearer` на всех запросах; админу доступна `/admin` —
  форма нового сеанса. В демо-режиме на Pages авторизации нет —
  симуляция остаётся без токенов.

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
Дефолт `DATABASE_URL` в коде — `postgres://cine:cine@localhost:15432/cine`
(порт compose-стенда).

## Заметки

- Схема БД управляется SQL-миграциями TypeORM (`apps/api/src/migrations`);
  `synchronize` удалён. Старые docker-томы, где схему собрал `synchronize`,
  нужно один раз сбросить: `docker compose down -v && docker compose up --build`
  (миграции пересоздадут схему, фильмы послеются заново).
- Обмен `cinema` объявляют и API, и воркер одинаковыми параметрами —
  кто стартует первым, тот и создаёт.
- SSE через nginx требует `proxy_buffering off` (уже в `apps/web/nginx.conf`),
  иначе события осядут в буфере прокси и не дойдут до EventSource.
