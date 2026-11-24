/**
 * BookingsService (unit): уровни «Киномана» в вердиктном цикле (этап 38) —
 * кэшбэк по уровню, письмо о повышении, tier в квоте Тарификатора.
 * Общий харнесс — фикстуры и фейки репозиториев/шин — в
 * ./bookings.service.harness; каждый домен деструктурирует нужное.
 */
import { buildBookingsHarness, type BookingsHarness, authUser, bookingFixture } from './bookings.service.harness';
import { BookingProcessedEvent } from './booking-events';

/** вердикт CONFIRMED по фикстурной брони user-1 */
const confirmed = (): BookingProcessedEvent => ({
  bookingId: 'booking-1',
  status: 'CONFIRMED',
  message: 'платёж прошёл',
  processedBy: 'ticket-worker',
  processedAt: new Date().toISOString(),
});

/** микротик: планировщики/микротаски хуков вердикта успевают отработать */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('BookingsService: уровни «Киномана» (unit)', () => {
  let h: BookingsHarness;

  beforeEach(async () => {
    h = await buildBookingsHarness();
    h.bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());
  });

  it('кэшбэк Новичка — базовый процент: 5% без прибавки', async () => {
    await h.service.handleProcessed(confirmed());
    await flushAsync();

    const cashback = h.bonusRows.find((r) => r.reason === 'cashback');
    // фикстура брони: totalRub 1200 → 5% = 60
    expect(cashback?.amount).toBe(60);
    // письма о повышении нет — уровень не менялся
    const keys = h.outboxInsert.mock.calls.map((c) => c[0].routingKey);
    expect(keys).not.toContain('loyalty.level.up');
  });

  it('покупка, перешагнувшая порог, сразу зарабатывает ставку уровня', async () => {
    // бронь 1200 ₽: траты до неё 2900, после — 4100 ≥ 3000 → Зритель (+2 п.п.)
    h.loyaltySpent['user-1'] = 2900 + 1200;

    await h.service.handleProcessed(confirmed());
    await flushAsync();

    const cashback = h.bonusRows.find((r) => r.reason === 'cashback');
    expect(cashback?.amount).toBe(Math.floor(1200 * 0.07)); // 7% = 84
  });

  it('повышение уровня — письмо в outbox той же транзакцией', async () => {
    h.loyaltySpent['user-1'] = 2900 + 960; // до вердикта был Новичок
    h.usersRows.push({
      id: 'user-1',
      referredBy: null,
      referralRewardedAt: null,
      email: 'cinephile@test.local',
    });

    await h.service.handleProcessed(confirmed());
    await flushAsync();

    const letter = h.outboxInsert.mock.calls
      .map((c) => c[0])
      .find((r) => r.routingKey === 'loyalty.level.up');
    expect(letter).toMatchObject({
      routingKey: 'loyalty.level.up',
      payload: { email: 'cinephile@test.local' },
    });
    expect(String(letter?.payload.message)).toContain('Зритель');
  });

  it('уровень без перехода порога — письма нет', async () => {
    // 1500 ₽ трат: до и после вердикта — Новичок
    h.loyaltySpent['user-1'] = 1500 + 960;

    await h.service.handleProcessed(confirmed());
    await flushAsync();

    const keys = h.outboxInsert.mock.calls.map((c) => c[0].routingKey);
    expect(keys).not.toContain('loyalty.level.up');
  });

  it('create() несёт уровень юзера в квот Тарификатора', async () => {
    h.loyalty.tierIndexOfUser.mockResolvedValueOnce(2); // Киноман

    await h.service.create(
      { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['5-7'] },
      authUser,
    );

    expect(h.loyalty.tierIndexOfUser).toHaveBeenCalledWith('user-1');
    expect(h.pricing.quote).toHaveBeenCalledWith(
      expect.objectContaining({ loyaltyTier: 2 }),
    );
  });

  it('сбой чтения уровня — квот без перка, бронь не падает', async () => {
    h.loyalty.tierIndexOfUser.mockRejectedValueOnce(new Error('pg is down'));

    const dto = await h.service.create(
      { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['5-7'] },
      authUser,
    );

    expect(dto.status).toBe('PENDING_PAYMENT');
    expect(h.pricing.quote).toHaveBeenCalledWith(
      expect.objectContaining({ loyaltyTier: 0 }),
    );
  });
});
