-- Схема напоминаний о сеансах. Применяется адаптером при старте,
-- IF NOT EXISTS делает повторный запуск безопасным. Правило файла:
-- исполняется по-стейтментно (разделитель «;»), точек с запятой
-- внутри выражений нет.
CREATE TABLE IF NOT EXISTS reminders (
    id          bigserial PRIMARY KEY,
    booking_id  text NOT NULL,             -- ключ идемпотентности
    user_id     text NOT NULL,
    email       text NOT NULL,             -- адресат «письма»
    movie_id    text NOT NULL DEFAULT '',
    movie_title text NOT NULL DEFAULT '',
    hall        text NOT NULL DEFAULT '',
    session_at  timestamptz NOT NULL,      -- момент сеанса
    seats       text NOT NULL DEFAULT '',  -- коды мест через запятую
    due_at      timestamptz NOT NULL,      -- момент отправки письма
    status      text NOT NULL,             -- SCHEDULED | SENT | CANCELLED
    reminded_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Ределивери вердикта воркера (at-least-once) не плодит записи.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reminders_booking ON reminders (booking_id);

-- Тикер читает только ожидающие отправки: частичный индекс держит
-- его дешёвым при росте истории.
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (due_at) WHERE status = 'SCHEDULED';
