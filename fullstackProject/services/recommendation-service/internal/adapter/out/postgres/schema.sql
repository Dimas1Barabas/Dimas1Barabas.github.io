-- Схема сигналов КиноСоветника. Применяется адаптером при старте,
-- IF NOT EXISTS делает повторный запуск безопасным. Правило файла:
-- исполняется по-стейтментно (разделитель «;»), точек с запятой
-- внутри выражений нет.
CREATE TABLE IF NOT EXISTS signals (
    id          bigserial PRIMARY KEY,
    dedup_key   text NOT NULL,             -- kind + ':' + bookingId/reviewId
    user_id     text NOT NULL,
    movie_id    text NOT NULL,
    movie_title text NOT NULL DEFAULT '',
    genre       text NOT NULL,
    kind        text NOT NULL,             -- booking | review
    rating      int NOT NULL DEFAULT 0,    -- 1..5, только review
    occurred_at timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Редоставления события (at-least-once) гасятся конфликтом вставки.
CREATE UNIQUE INDEX IF NOT EXISTS uq_signals_dedup ON signals (dedup_key);

-- Профиль зрителя читается всей историей его сигналов.
CREATE INDEX IF NOT EXISTS idx_signals_user ON signals (user_id);
