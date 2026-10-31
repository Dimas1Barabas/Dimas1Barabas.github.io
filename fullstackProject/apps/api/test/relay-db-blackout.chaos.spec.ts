/**
 * CHS-3: блэкаут базы у Курьера (этап 24, хаос через toxiproxy).
 *
 * Удаление прокси pg-relay обрывает ТОЛЬКО соединения Курьера с Postgres:
 * API пишет в ту же базу через собственный pg-api. Сбивается самый
 * больной участник — Курьер без базы не ни читает хвост, ни отдаёт витрину.
 *
 * Как и в CHS-2, вердикт брони отложен (payment.wait стоит в outbox —
 * Курьер не может его прочитать), но не потерян: после восстановления
 * пула соединений накопленный хвост доезжает, воркер проводит бронь,
 * письмо password_reset приходит.
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

jest.setTimeout(300_000);

let before: OutboxStats | null = null;

beforeAll(async () => {
  await chaosBootstrap();
  if (!ready) return;
  // чистый слэйт при живом Курьере — база отсчёта
  const warm = await paidBooking('Хаос База Разогрев');
  await waitVerdict(warm.id);
  await waitDrained(90_000);
  before = await relayStats();
  // блэкаут до событий сценария
  await blackout('pg-relay');
});

afterAll(async () => {
  if (!ready) return;
  await restore('pg-relay');
});

it('база недоступна одному Курьеру: хвост копится в выжившей базе и доезжает после восстановления', async () => {
  if (!ready) return;
  expect(before).not.toBeNull();

  // API жив: сброс пароля уходит в outbox, бронь создаётся и оплачивается —
  // записи переживают беду Курьера в общей базе
  await requestPasswordReset(email);
  const frozen = await paidBooking('Хаос База 1');
  expect(frozen.status).toBe('PENDING');

  // витрина Курьера: процесс жив, но стата идёт в упавшую базу —
  // ждём не таймаута фетча, а честной ошибки обработчика
  await new Promise((resolve) => setTimeout(resolve, 5000));
  expect(await relayStats()).toBeNull();

  // восстановление: пул переподключается, накопленный хвост — в доставку
  await restore('pg-relay');
  await waitDrained(150_000);

  // отложенный вердикт дошёл до воркера — бронь проведена, не потеряна
  const verdict = await waitVerdict(frozen.id);
  expect(verdict.status).toBe('CONFIRMED');

  // письмо, невозможное без доставки хвоста
  const letter = await resetLetter(email, 60_000);
  expect(letter).not.toBeNull();
});
