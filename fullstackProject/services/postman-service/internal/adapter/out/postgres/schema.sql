-- Схема вебхуков «Почтальона». Применяется адаптером при старте,
-- IF NOT EXISTS делает повторный запуск безопасным. Правило файла:
-- исполняется по-стейтментно (разделитель «;»), точек с запятой
-- внутри выражений нет.

-- Подписки партнёров: куда доставлять (url), чем подписывать (secret),
-- фильтр типов (events, csv; '' = все события брони).
CREATE TABLE IF NOT EXISTS postman_subscriptions (
    id         text PRIMARY KEY,
    url        text NOT NULL,
    secret     text NOT NULL,
    events     text NOT NULL DEFAULT '',  -- csv: booking.created,booking.processed,...
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Доставки: одна строка = одно событие одному партнёру. Идемпотентность
-- fan-out сидит на уникальности (subscription_id, event_id): ределивери
-- брокера повторов не плодит (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS postman_deliveries (
    id              text PRIMARY KEY,
    subscription_id text NOT NULL REFERENCES postman_subscriptions(id) ON DELETE CASCADE,
    event_id        text NOT NULL,
    event_type      text NOT NULL,
    payload         jsonb NOT NULL,
    status          text NOT NULL,               -- queued | delivered | dead
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,                 -- NULL у delivered/dead (расписания нет)
    last_error      text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL,
    delivered_at    timestamptz
);

-- Пара «подписка + событие» уникальна — идемпотентность Enqueue.
CREATE UNIQUE INDEX IF NOT EXISTS uq_postman_delivery
    ON postman_deliveries (subscription_id, event_id);

-- Очередь тикера: настоевшие queued, старыми первыми. Частичный индекс
-- держит его дешёвым при росте истории доставок.
CREATE INDEX IF NOT EXISTS idx_postman_deliveries_due
    ON postman_deliveries (next_attempt_at)
    WHERE status = 'queued' AND next_attempt_at IS NOT NULL;

-- Витрина: свежие доставки сверху, фильтр по подписке.
CREATE INDEX IF NOT EXISTS idx_postman_deliveries_recent
    ON postman_deliveries (created_at DESC);
