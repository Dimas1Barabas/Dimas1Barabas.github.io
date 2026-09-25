-- Схема Тарификатора. Применяется адаптером при старте, IF NOT EXISTS
-- делает повторный запуск безопасным. Правило файла: исполняется
-- по-стейтментно (разделитель «;»), точек с запятой внутри выражений нет.

-- проекция спроса: сколько мест сеанса занято (по событиям брони)
CREATE TABLE IF NOT EXISTS demand (
    session_id text PRIMARY KEY,
    occupied   integer NOT NULL DEFAULT 0,   -- занятые места, ≥ 0
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- журнал применённых событий: redelivery (at-least-once) не должен
-- задваивать спрос; uq (booking_id, kind) — по одному «held» и одному
-- «released» на бронь (жизненный цикл брони проходит каждый максимум раз)
CREATE TABLE IF NOT EXISTS applied_events (
    id         bigserial PRIMARY KEY,
    booking_id text NOT NULL,
    kind       text NOT NULL,                -- held | released
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_applied_booking_kind ON applied_events (booking_id, kind);

-- история проведённых квотов: витрина /prices, как очередь напоминаний
CREATE TABLE IF NOT EXISTS quotes (
    id            bigserial PRIMARY KEY,
    session_id    text NOT NULL,
    base_price_rub integer NOT NULL,
    price_rub     integer NOT NULL,
    factors       text NOT NULL DEFAULT '',  -- «evening+20%, weekend+10%»
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes (created_at);
