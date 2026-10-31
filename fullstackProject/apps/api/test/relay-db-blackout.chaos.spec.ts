/**
 * CHS-3: блэкаут базы у Курьера (этап 24, хаос через toxiproxy).
 *
 * Удаление прокси pg-relay обрывает ТОЛЬКО соединения Курьера с Postgres:
 * API пишет в ту же базу через собственный pg-api. Сбивается самый
 * больной участник — Курьер без базы не ни читает хвост, ни отдаёт витрину.
 *
 * Инварианты:
 *  - брони и сброс пароля проходят: outbox-записи пишет API, его канал цел;
 *  - витрина Курьера честно падает (500: собственная база недоступна),
 *    а не врёт нулями;
 *  - после восстановления пула соединений Курьер переподключается и
 *    разъезжает весь накопленный хвост — письмо password_reset доходит.
 *
 * Стенд: docker compose -f docker-compose.yml -f docker-compose.chaos.yml up
 * (или chaos-джоба CI). Без стенда с оверлеем файл пропускается.
 */
import {
  chaosBootstrap,
  ready,
  email,
  blackout,
  restore,
  relayStats,
  paidBooking,
  waitVerdict,
  waitDrained,
  requestPasswordReset,
  resetLetter,
  OutboxStats,
} from './chaos-harness';

jest.setTimeout(240_000);

let before: OutboxStats | null = null;

beforeAll(async () => {
  await chaosBootstrap();
  if (!ready) return;
  before = await relayStats();
  // блэкаут до первых событий сценария
  await blackout('pg-relay');
});

afterAll(async () => {
  if (!ready) return;
  await restore('pg-relay');
});

it('база недоступна одному Курьеру: хвост копится в выжившей базе и доезжает после восстановления', async () => {
  if (!ready) return;
  expect(before).not.toBeNull();

  // бронь и сброс под чужим блэкаутом: API пишет outbox в общую базу
  // через свой канал — записи не зависят от беды Курьера
  const paid = await paidBooking('Хаос База');
  expect((await waitVerdict(paid.id)).status).toBe('CONFIRMED');
  await requestPasswordReset(email);

  // витрина Курьера: процесс жив, но стата идёт в упавшую базу —
  // ждём не таймаута фетча, а честной ошибки обработчика
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect(await relayStats()).toBeNull();

  // восстановление: пул переподключается, хвост (сколько накопилось —
  // столько и доедет) разъезжается без потерь
  await restore('pg-relay');
  await waitDrained(150_000);

  // письмо, невозможное без доставки хвоста
  const letter = await resetLetter(email, 60_000);
  expect(letter).not.toBeNull();
});
