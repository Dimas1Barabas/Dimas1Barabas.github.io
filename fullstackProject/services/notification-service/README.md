# notification-service — Go, гексагональная архитектура

Слушает вердикты брони на обмене `cinema` (`booking.processed`,
`booking.refunded`, `booking.expired`) и письма сброса пароля от NestJS API
(`user.password.reset`), превращает их в клиентские уведомления,
«отправляет» (в стенде — печатает письмо в лог) и хранит историю —
в памяти (дефолт) или в собственной базе Postgres.

```
ticket-worker ──booking.processed──▶ ┌──────────────────────┐
ticket-worker ──booking.refunded───▶ │ notification-service │──▶ лог-«email»
ticket-worker ──booking.expired────▶ └──────────┬───────────┘
NestJS API ────user.password.reset─▶       история: память | Postgres
                                                │ GET /notifications
```

## Гексагон: почему так

Домен и use-cases стоят в центре и не знают ни о RabbitMQ, ни о HTTP,
ни о хранилище. Всё внешнее — заменяемые адаптеры за портами-интерфейсами
(`internal/domain/ports.go`). Сменить консоль на SMTP или память
на Postgres — это новый файл адаптера плюс строка в `main`, домен
и сценарии не меняются ни на символ (проверено: postgres-адаптер появился
именно так). Направление зависимостей — только внутрь:
`adapter → service → domain`.

```
cmd/notification/          composition root: только сборка зависимостей
internal/
  domain/                  агрегат Notification, Outcome, порты Sender/Repository/Metrics
  service/                 use-case Notifier: вердикт → письмо → история
  adapter/in/amqp/         консьюмер: топология, retry/parking, маппинг в Outcome
  adapter/in/httpapi/      /health /stats /notifications
  adapter/out/console/     «отправка email» в stdout
  adapter/out/memory/      кольцевой буфер истории (дефолт) + счётчики метрик
  adapter/out/postgres/    история в собственной БД; базу и схему создаёт сам
  config/                  env-настройки (вне гексагона)
```

Тесты показывают смысл раскладки: домен и use-case проверяются стабами
портов (сбой шлюза, ядовитый вердикт), HTTP — на httptest с memory-адаптерами,
и ни один тест не поднимает брокер. Postgres-адаптер проверяется живыми
тестами против локального стенда — без поднятого PG они честно скипаются
(как e2e API), а тестовая база пересоздаётся каждым прогоном.

## Что делает

1. Объявляет очередь `notification.events` и биндится на четыре события:
   три вердикта брони + письмо сброса пароля (prefetch = 1).
2. Событие → доменное уведомление: заголовок и тип — решение домена,
   текст — от воркера/API. Для `user.password.reset` адресат (email) едет
   в поле-ссылку `bookingId` — хранилища и фильтр `/notifications` не
   меняются; письмо без адресата — ядовитое (parking).
3. «Отправляет письмо» и сохраняет историю: кольцевая память (дефолт,
   рестарт теряет) или Postgres в собственной базе `cine_notifications`
   того же кластера — базу и схему сервис создаёт сам при старте,
   история переживает рестарты.
4. Ядовитые события (битый JSON, неизвестный routing key/вердикт) —
   в `notification.events.parking`; транзиентные — в retry-очередь
   с TTL и возвратом в свой поток (зеркально ticket-worker).
5. Отдаёт `GET /health`, `GET /stats`, `GET /notifications?bookingId=&limit=`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `AMQP_URL` | `amqp://guest:guest@localhost:5672/` | адрес RabbitMQ |
| `HTTP_ADDR` | `:8080` | адрес HTTP-эндпоинтов |
| `STORAGE` | `memory` | `memory` \| `postgres` — хранилище истории |
| `DATABASE_URL` | `postgres://cine:cine@localhost:15432/cine_notifications` | DSN (при `STORAGE=postgres`) |
| `BUFFER_SIZE` | `500` | размер кольцевого буфера (только `STORAGE=memory`) |
| `RETRY_MAX_ATTEMPTS` | `3` | попыток обработки, дальше — parking |
| `RETRY_TTL_MS` | `5000` | пауза retry-очереди |
| `TEST_DATABASE_URL` | `postgres://cine:cine@localhost:15432/cine_notifications_test` | база live-тестов (пересоздаётся) |

## Локальный запуск

```bash
go run ./cmd/notification
# персистентная история (нужен поднятый postgres стенда):
STORAGE=postgres go run ./cmd/notification
# или в составе стенда, из корня fullstackProject:
docker compose up --build notification
# история и метрики:
curl http://localhost:18082/notifications
curl http://localhost:18082/stats
# live-тесты postgres-адаптера (PG не поднят — скипнутся с пояснением):
go test ./...
```
