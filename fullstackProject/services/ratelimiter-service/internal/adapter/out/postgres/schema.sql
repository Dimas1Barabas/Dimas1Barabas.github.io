-- Схема Привратника. Применяется адаптером при старте, IF NOT EXISTS
-- делает повторный запуск безопасным. Правило файла: исполняется
-- по-стейтментно (разделитель «;»), точек с запятой внутри выражений нет.

-- token-корзины: остаток клиента по действию. Долив и списание делает
-- один стейтмент takeSQL: гонка двух запросов не может списать дважды
-- из одного остатка (максимум — недосчитать один токен на «первом визите»,
-- на стендовых масштабах осознанно)
CREATE TABLE IF NOT EXISTS buckets (
    action     text NOT NULL,             -- bookings.create | auth.login
    client_key text NOT NULL,             -- user id / email / ip
    tokens     double precision NOT NULL, -- дробные токены после долива
    last_taken boolean NOT NULL DEFAULT TRUE, -- вердикт последней проверки (витрина/RETURNING)
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_buckets_action_key ON buckets (action, client_key);

CREATE INDEX IF NOT EXISTS idx_buckets_updated ON buckets (updated_at);
