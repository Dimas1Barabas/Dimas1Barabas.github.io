-- Схема истории уведомлений. Применяется адаптером при старте,
-- IF NOT EXISTS делает повторный запуск безопасным. Правило файла:
-- исполняется по-стейтментно (разделитель «;»), точек с запятой
-- внутри выражений нет.
CREATE TABLE IF NOT EXISTS notifications (
    id         text PRIMARY KEY, -- timestamp + bookingId, генерит фабрика домена
    booking_id text NOT NULL,
    kind       text NOT NULL,    -- booking_confirmed | booking_failed | ...
    title      text NOT NULL,
    body       text NOT NULL,
    channel    text NOT NULL,    -- email
    status     text NOT NULL,    -- SENT | FAILED
    error      text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_booking_id
    ON notifications (booking_id);
