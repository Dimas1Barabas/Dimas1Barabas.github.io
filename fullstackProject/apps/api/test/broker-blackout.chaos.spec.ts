/**
 * CHS-2: блэкаут брокера у Курьера (этап 24, хаос через toxiproxy).
 *
 * Удаление прокси amqp-relay обрывает ТОЛЬКО соединения Курьера с
 * RabbitMQ: у API собственный прокси amqp-api, воркер ходит в брокер
 * напрямую — сбой изолирован до одного участника контура.
 *
 * Инварианты:
 *  - брони под блэкаутом проводят вердикты (путь API → брокер → воркер
 *    не задет);
 *  - события копятся в pending: записи outbox переживают недоступность
 *    брокера, дропов нет;
 *  - попытки публикации честно падают — failedAttempts растёт, Курьер
 *    не притворяется, что всё хорошо;
 *  - после снятия блэкаута хвост разъезжается целиком, письмо
 *    password_reset доходит.
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
  // блэкаут до первых событий сценария: успеть до него Курьер не может
  await blackout('amqp-relay');
});

afterAll(async () => {
  // стенд общий: оставляем прокси на месте независимо от исхода спеки
  if (!ready) return;
  await restore('amqp-relay');
});

it('брокер недоступен одному Курьеру: события копятся и доезжают после восстановления', async () => {
  if (!ready) return;
  expect(before).not.toBeNull();

  // две брони под блэкаутом Курьера: вердикты идут мимо него
  const first = await paidBooking('Хаос Брокер 1');
  expect((await waitVerdict(first.id)).status).toBe('CONFIRMED');
  const second = await paidBooking('Хаос Брокер 2');
  expect((await waitVerdict(second.id)).status).toBe('CONFIRMED');

  // событие сброса пароля тоже копится в хвосте
  await requestPasswordReset(email);

  // даём тикам Курьера (500мс) попытаться и честно ошибиться в закрытый
  // порт; 6с — несколько попыток при бэкоффе 500мс→1с→2с
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const during = await relayStats();
  expect(during).not.toBeNull(); // PG Курьера не задет — витрина жива

  // 5 событий: booking.payment.wait ×2, recommendation.booking.confirmed ×2,
  // user.password.reset — все стоят в pending, ни одно не потерялось
  expect(during!.pending).toBeGreaterThanOrEqual(before!.pending + 5);
  expect(during!.failedAttempts).toBeGreaterThan(before!.failedAttempts);

  // снимаем блэкаут: реконнект (бэкофф 3с) + разъезд хвоста
  // (next_attempt отодвинут бэкоффом неудач до ~8с) — таймаут с запасом
  await restore('amqp-relay');
  const drained = await waitDrained(150_000);
  expect(drained.publishedTotal).toBeGreaterThanOrEqual(
    before!.publishedTotal + 5,
  );

  // письмо, невозможное без доставки хвоста
  const letter = await resetLetter(email, 60_000);
  expect(letter).not.toBeNull();
});
