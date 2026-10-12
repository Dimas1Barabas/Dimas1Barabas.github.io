-- Схема Аналитика. Применяется адаптером при старте, IF NOT EXISTS
-- делает повторный запуск безопасным. Правило файла: исполняется
-- по-стейтментно (разделитель «;»), точек с запятой внутри выражений нет.

-- воронка пути зрителя: счётчики шагов за всё время (demo-стенд без
-- нарезки по дням — витрине интересна текущая картина, не история)
CREATE TABLE IF NOT EXISTS funnel (
    step  text PRIMARY KEY,
    count bigint NOT NULL DEFAULT 0
);

-- интерес к фильму: открытия модалки против оплаченных броней;
-- конверсию (bookings/opens) считает витрина
CREATE TABLE IF NOT EXISTS movie_interest (
    movie_id  text PRIMARY KEY,
    opens     bigint NOT NULL DEFAULT 0,
    bookings  bigint NOT NULL DEFAULT 0
);

-- страницы: просмотры и суммарное активное время (фон вкладки
-- трекер не считает)
CREATE TABLE IF NOT EXISTS page_stats (
    route    text PRIMARY KEY,
    views    bigint NOT NULL DEFAULT 0,
    dwell_ms bigint NOT NULL DEFAULT 0
);

-- тепловая карта мест: клики по залу, без сеансов — картина зала
-- живёт дольше любого сеанса
CREATE TABLE IF NOT EXISTS seat_heat (
    hall   text NOT NULL,
    seat   text NOT NULL,
    clicks bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (hall, seat)
);

-- время в модалке по глубине пройденного пути (session|seats|created):
-- «где люди застревают» — среднее считает витрина (total_ms/events)
CREATE TABLE IF NOT EXISTS modal_stats (
    deepest  text PRIMARY KEY,
    events   bigint NOT NULL DEFAULT 0,
    total_ms bigint NOT NULL DEFAULT 0
);
