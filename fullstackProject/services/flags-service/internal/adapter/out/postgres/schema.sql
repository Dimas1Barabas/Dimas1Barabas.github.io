-- Схема «Суфлёра». Применяется адаптером при старте, IF NOT EXISTS
-- делает повторный запуск безопасным. Правило файла: исполняется
-- по-стейтментно (разделитель «;»), точек с запятой внутри выражений нет.

-- флаги: состояние раскатки фичи, один ряд на ключ
CREATE TABLE IF NOT EXISTS flags (
    key         text PRIMARY KEY,              -- checkout.new_flow
    description text NOT NULL DEFAULT '',      -- что за фича, человеком
    enabled     boolean NOT NULL DEFAULT FALSE,-- мастер-тумблер (пауза раскатки)
    percentage  int NOT NULL DEFAULT 0 CHECK (percentage BETWEEN 0 AND 100),
    killed      boolean NOT NULL DEFAULT FALSE,-- kill-switch: оф всем
    updated_by  text NOT NULL DEFAULT '',      -- автор последней правки
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- аудит правок: снимок состояния ПОСЛЕ каждой записи. Намеренно без
-- FK на flags: история переживает удаление флага — «кто выключал»
-- не должен пропадать вместе с тумблером
CREATE TABLE IF NOT EXISTS flag_revisions (
    id          bigserial PRIMARY KEY,
    key         text NOT NULL,
    changed_by  text NOT NULL DEFAULT '',
    changed_at  timestamptz NOT NULL DEFAULT now(),
    description text NOT NULL DEFAULT '',
    enabled     boolean NOT NULL,
    percentage  int NOT NULL,
    killed      boolean NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flag_revisions_key ON flag_revisions (key, id DESC);
