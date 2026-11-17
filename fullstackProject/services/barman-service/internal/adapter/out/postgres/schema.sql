-- Схема очереди кинобара Бармена. Применяется адаптером при старте,
-- IF NOT EXISTS делает повторный запуск безопасным. Правило файла:
-- исполняется по-стейтментно (разделитель «;»), точек с запятой
-- внутри выражений нет.
CREATE TABLE IF NOT EXISTS bar_orders (
    order_id      text PRIMARY KEY,           -- ключ идемпотентности ределивери
    user_id       text NOT NULL,
    email         text NOT NULL,              -- адресат «письма» о готовности
    customer_name text NOT NULL,              -- «для кого» на экране бара
    session_id    text NOT NULL DEFAULT '',   -- '' — заказ без сеанса
    session_at    timestamptz,                -- NULL — заказ без сеанса
    hall          text NOT NULL DEFAULT '',
    items         jsonb NOT NULL,             -- снимки позиций: имя/цена/кол-во
    total_rub     integer NOT NULL,
    status        text NOT NULL,              -- NEW | PREPARING | READY | PICKED_UP | CANCELLED
    created_at    timestamptz NOT NULL DEFAULT now(),
    changed_at    timestamptz NOT NULL DEFAULT now()
);

-- Экран бара: три активные колонки по времени приёма. Частичный индекс
-- держит их дешёвыми при росте истории закрытых заказов.
CREATE INDEX IF NOT EXISTS idx_bar_orders_active
    ON bar_orders (status, created_at)
    WHERE status IN ('NEW', 'PREPARING', 'READY');

-- Лента «недавно закрытые»: выданные и отменённые, свежие сверху.
CREATE INDEX IF NOT EXISTS idx_bar_orders_closed
    ON bar_orders (changed_at DESC)
    WHERE status IN ('PICKED_UP', 'CANCELLED');
