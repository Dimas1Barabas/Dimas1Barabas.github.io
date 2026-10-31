/**
 * CHS-1: латентность до Postgres (этап 24, хаос через toxiproxy).
 *
 * Toxic latency 400 мс в оба направления на pg-api и pg-relay: каждый
 * Round-Trip к базе растёт на ~800 мс — база «тормозит», но жива. Сбой
 * деградации, а не обрыва: поток не должен рваться.
 *
 * Инварианты:
 *  - полный цикл брони проходит: создание → оплата → вердикт воркера
 *    (воркер ходит в PG напрямую, его путь не замедлен);
 *  - хвост outbox разъезжается: Курьер доносит всё под латентностью;
 *  - письмо password_reset доходит — единственный путь этого письма
 *    лежит через outbox → Курьер → брокер → notification.
 *
 * Стенд: docker compose -f docker-compose.yml -f docker-compose.chaos.yml up
 * (или chaos-джоба CI). Без стенда с оверлеем файл пропускается.
 */
import {
  chaosBootstrap,
  ready,
  email,
  addLatency,
  clearToxics,
  relayStats,
  paidBooking,
  waitVerdict,
  waitDrained,
  requestPasswordReset,
  resetLetter,
} from './chaos-harness';

jest.setTimeout(180_000);

/** витрина до инъекции: на свежем CI-стенде нули, локально — какой есть */
let baseline = { pending: 0, published: 0 };

beforeAll(async () => {
  await chaosBootstrap();
  if (!ready) return;
  const st = await relayStats();
  baseline = { pending: st?.pending ?? 0, published: st?.publishedTotal ?? 0 };
  await addLatency('pg-api', 400);
  await addLatency('pg-relay', 400);
});

afterAll(async () => {
  // токсики переживают спеку — снимаем независимо от её исхода
  if (!ready) return;
  await clearToxics('pg-api');
  await clearToxics('pg-relay');
});

it('деградация канала до PG не рвёт цикл брони и доставку outbox', async () => {
  if (!ready) return;

  // цикл брони под латентностью: каждый запрос API несёт ~800 мс
  // на Round-Trip к базе, транзакция брони — десяток Round-Trip'ов
  const paid = await paidBooking('Хаос Латентность');
  const verdict = await waitVerdict(paid.id);
  expect(verdict.status).toBe('CONFIRMED');
  expect(verdict.processedBy).toBe('go-worker-1');

  // событие сброса пароля уходит в outbox той же транзакцией
  await requestPasswordReset(email);

  // хвост разъезжается: батчи Курьера тоже под латентностью — таймаут щедрый.
  // Успешная бронь + сброс = 3 события: booking.payment.wait,
  // recommendation.booking.confirmed, user.password.reset
  const drained = await waitDrained(120_000);
  expect(drained.publishedTotal).toBeGreaterThanOrEqual(baseline.published + 3);

  // письмо дошло: без Курьера его не существует
  const letter = await resetLetter(email, 60_000);
  expect(letter).not.toBeNull();
  expect(letter!.body).toContain('reset-password'); // ссылка сброса в теле
});
