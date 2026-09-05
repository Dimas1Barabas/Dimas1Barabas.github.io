# ticket-worker — микросервис на Go

Обрабатывает брони из RabbitMQ и возвращает результат обратно в API.

```
NestJS API ──booking.created──▶ [cinema exchange] ──▶ worker.booking.created ──▶ ticket-worker (Go)
                                                                                        │
NestJS API ◀──booking.processed── [cinema exchange] ◀──────────────────────────────────┘

NestJS API ──booking.cancelled─▶ [cinema exchange] ──▶ worker.booking.cancelled ─▶ ticket-worker (Go)
                                                                                        │  «возврат платежа»
NestJS API ◀──booking.refunded── [cinema exchange] ◀───────────────────────────────────┘
```

## Что делает

1. Слушает очередь `worker.booking.created` (обмен `cinema`, topic, prefetch = 1).
2. Имитирует платёжный шлюз: задержка 1,2–2,8 с + вердикт (~90% успех).
3. Публикует `booking.processed` со статусом `CONFIRMED`/`FAILED`, деталями мест и своим именем.
4. Сага отмены: слушает `worker.booking.cancelled`, «возвращает платёж»
   (0,8–1,6 с, ~90% успех) и публикует `booking.refunded` с вердиктом
   `CANCELLED`/`REFUND_FAILED`.
5. Автоматический реконнект к брокеру с бэкоффом, `ack`/`nack` с ретраем при сбое публикации.
6. Отдаёт метрики: `GET /health`, `GET /stats`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `AMQP_URL` | `amqp://guest:guest@localhost:5672/` | адрес RabbitMQ |
| `HTTP_ADDR` | `:8081` | адрес health/stats |
| `WORKER_ID` | `go-worker-1` | имя воркера (видно в брони) |
| `PROCESS_MIN_MS` / `PROCESS_MAX_MS` | `1200` / `2800` | границы «оплаты» |
| `SUCCESS_RATE` | `0.9` | вероятность успеха оплаты |
| `REFUND_MIN_MS` / `REFUND_MAX_MS` | `800` / `1600` | границы «возврата» |
| `REFUND_SUCCESS_RATE` | `0.9` | вероятность успешного возврата |

## Локальный запуск

```bash
go run .
# или в составе всего стенда, из корня fullstackProject:
docker compose up --build worker
```
