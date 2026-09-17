# notification-service — Go, гексагональная архитектура

Слушает вердикты брони на обмене `cinema` (`booking.processed`,
`booking.refunded`, `booking.expired`), превращает их в клиентские
уведомления, «отправляет» (в стенде — печатает письмо в лог) и хранит
историю в памяти.

```
ticket-worker ──booking.processed──▶ ┌──────────────────────┐
ticket-worker ──booking.refunded───▶ │ notification-service │──▶ лог-«email»
ticket-worker ──booking.expired────▶ └──────────┬───────────┘
                                                │ GET /notifications
```

## Гексагон: почему так

Домен и use-cases стоят в центре и не знают ни о RabbitMQ, ни о HTTP,
ни о хранилище. Всё внешнее — заменяемые адаптеры за портами-интерфейсами
(`internal/domain/ports.go`). Сменить консоль на SMTP или память
на Postgres — это новый файл адаптера плюс строка в `main`, домен
и сценарии не меняются ни на символ. Направление зависимостей — только
внутрь: `adapter → service → domain`.

```
cmd/notification/          composition root: только сборка зависимостей
internal/
  domain/                  агрегат Notification, Outcome, порты Sender/Repository/Metrics
  service/                 use-case Notifier: вердикт → письмо → история
  adapter/in/amqp/         консьюмер: топология, retry/parking, маппинг в Outcome
  adapter/in/httpapi/      /health /stats /notifications
  adapter/out/console/     «отправка email» в stdout
  adapter/out/memory/      кольцевой буфер истории + счётчики метрик
  config/                  env-настройки (вне гексагона)
```

Тесты показывают смысл раскладки: домен и use-case проверяются стабами
порттов (сбой шлюза, ядовитый вердикт), HTTP — на httptest с memory-адаптерами,
и ни один тест не поднимает брокер.

## Что делает

1. Объявляет очередь `notification.events` и биндится на три вердикта
   (prefetch = 1).
2. Вердикт → доменное уведомление: заголовок и тип — решение домена,
   текст — от воркера.
3. «Отправляет письмо» и сохраняет в кольцевой буфер (рестарт историю
   теряет — стенд, не продакшен).
4. Ядовитые события (битый JSON, неизвестный routing key/вердикт) —
   в `notification.events.parking`; транзиентные — в retry-очередь
   с TTL и возвратом в свой поток (зеркально ticket-worker).
5. Отдаёт `GET /health`, `GET /stats`, `GET /notifications?bookingId=&limit=`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `AMQP_URL` | `amqp://guest:guest@localhost:5672/` | адрес RabbitMQ |
| `HTTP_ADDR` | `:8080` | адрес HTTP-эндпоинтов |
| `BUFFER_SIZE` | `500` | сколько последних уведомлений держит память |
| `RETRY_MAX_ATTEMPTS` | `3` | попыток обработки, дальше — parking |
| `RETRY_TTL_MS` | `5000` | пауза retry-очереди |

## Локальный запуск

```bash
go run ./cmd/notification
# или в составе стенда, из корня fullstackProject:
docker compose up --build notification
# история и метрики:
curl http://localhost:18082/notifications
curl http://localhost:18082/stats
```
