/**
 * CHS-2: блэкаут брокера у Курьера (этап 24, хаос через toxiproxy).
 *
 * Удаление прокси amqp-relay обрывает ТОЛЬКО соединения Курьера с RabbitMQ:
 * у API собственный прокси amqp-api, воркер ходит в брокер напрямую.
 *
 * Открытие первого живого прогона: вердикт брони опосредован Курьером —
 * booking.payment.wait едет в брокер через outbox, и блэкаут Курьера
 * ЗАМОРАЖИВАЕТ вердикты (бронь стоит в PENDING), хотя сам API жив:
 * создание и оплата проходят без ошибок. Сценарий фиксирует это как
 * инвариант дизайна: вердикт отложен, но не потерян — после
 * восстановления хвост доезжает, воркер проводит бронь, письмо
 * password_reset приходит.
 *
 * Стенд: docker compose -f docker-compose.yml -f docker-compose.chaos.yml up
 * (или chaos-джоба CI). Без стенда с оверлеем файл пропускается.
 */
import {
  chaosBootstrap,
  ready,
  email,
  capi,
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
  // чистый слэйт при живом Курьере: бронь с вердиктом + разъехавшийся
  // хвост — база отсчёта без чужих записей
  const warm = await paidBooking('Хаос Брокер Разогрев');
  await waitVerdict(warm.id);
  await waitDrained(90_000);
  before = await relayStats();
  // блэкаут до событий сценария: успеть до него Курьер не может
  await blackout('amqp-relay');
});

afterAll(async () => {
  // стенд общий: оставляем прокси на месте независимо от исхода спеки
  if (!ready) return;
  await restore('amqp-relay');
});

it('брокер недоступен одному Курьеру: события копятся, вердикт отложен — и доезжает после восстановления', async () => {
  if (!ready) return;
  expect(before).not.toBeNull();

  // API жив: сброс пароля уходит в outbox, бронь создаётся и оплачивается
  await requestPasswordReset(email);
  const frozen = await paidBooking('Хаос Брокер 1');
  expect(frozen.status).toBe('PENDING');

  // тики Курьера (500мс) долбятся в закрытый порт: попытки честно падают,
  // хвост растёт; 8с — несколько попыток при бэкоффе 500мс→1с→2с
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const during = await relayStats();
  expect(during).not.toBeNull(); // PG Курьера не задет — витрина жива

  // 2 события: user.password.reset + booking.payment.wait — в pending,
  // ни одно не потерялось и не задвоилось
  expect(during!.pending).toBeGreaterThanOrEqual(before!.pending + 2);
  expect(during!.failedAttempts).toBeGreaterThan(before!.failedAttempts);

  // вердикт отложен: пока payment.wait не доставлен, воркер бронь не видит
  const list = await capi<{ id: string; status: string }[]>('/bookings');
  expect(list.find((b) => b.id === frozen.id)?.status).toBe('PENDING');

  // снимаем блэкаут: реконнект (бэкофф 3с) + разъезд хвоста
  // (next_attempt отодвинут бэкоффом неудач — таймаут с запасом)
  await restore('amqp-relay');
  await waitDrained(150_000);

  // отложенный вердикт дошёл до воркера — бронь проведена, не потеряна
  const verdict = await waitVerdict(frozen.id);
  expect(verdict.status).toBe('CONFIRMED');

  // письмо, невозможное без доставки хвоста
  const letter = await resetLetter(email, 60_000);
  expect(letter).not.toBeNull();
});
