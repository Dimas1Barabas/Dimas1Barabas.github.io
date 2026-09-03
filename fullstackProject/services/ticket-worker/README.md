# ticket-worker — микросервис на Go

Обрабатывает брони из RabbitMQ и возвращает результат обратно в API.

```
NestJS API ──booking.created──▶ [cinema exchange] ──▶ worker.booking.created ──▶ ticket-worker (Go)
                                                                                        │
NestJS API ◀──booking.processed── [cinema exchange] ◀──────────────────────────────────┘
```

## Что делает

1. Слушает очередь `worker.booking.created` (обмен `cinema`, topic, prefetch = 1).
2. Имитирует платёжный шлюз: задержка 1,2–2,8 с + вердикт (~90% успех).
3. Публикует `booking.processed` со статусом `CONFIRMED`/`FAILED`, деталями мест и своим именем.
4. Автоматический реконнект к брокеру с бэкоффом, `ack`/`nack` с ретраем при сбое публикации.
5. Отдаёт метрики: `GET /health`, `GET /stats`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `AMQP_URL` | `amqp://guest:guest@localhost:5672/` | адрес RabbitMQ |
| `HTTP_ADDR` | `:8081` | адрес health/stats |
| `WORKER_ID` | `go-worker-1` | имя воркера (видно в брони) |
| `PROCESS_MIN_MS` / `PROCESS_MAX_MS` | `1200` / `2800` | границы «оплаты» |
| `SUCCESS_RATE` | `0.9` | вероятность успеха |

## Локальный запуск

```bash
go run .
# или в составе всего стенда, из корня fullstackProject:
docker compose up --build worker
```
