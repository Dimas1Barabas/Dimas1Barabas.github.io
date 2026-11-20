-- Схема Детектива. Применяется адаптером при старте, IF NOT EXISTS
-- делает повторный запуск безопасным. Правило файла: исполняется
-- по-стейтментно (разделитель «;»), точек с запятой внутри выражений нет.

-- решения антифрода: одна строка на бронь (идемпотентный ключ),
-- жизненный цикл — статусом; факты храним с решением: витрина
-- показывает, что именно насторожило, даже если история уже уехала
CREATE TABLE IF NOT EXISTS decisions (
    booking_id       text PRIMARY KEY,        -- идемпотентность Score
    user_id          text NOT NULL,
    session_id       text NOT NULL,
    seats_count      int  NOT NULL,
    total_rub        int  NOT NULL,
    account_age_days int  NOT NULL,
    bookings_24h     int  NOT NULL,
    cancels_24h      int  NOT NULL,
    failed_24h       int  NOT NULL,
    score            int  NOT NULL,
    verdict          text NOT NULL,           -- allow | review | block
    reasons          text NOT NULL,           -- коды правил через запятую
    status           text NOT NULL,           -- auto_* | pending_review | approved | rejected
    resolved_by      text NOT NULL DEFAULT '',
    resolved_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status);
