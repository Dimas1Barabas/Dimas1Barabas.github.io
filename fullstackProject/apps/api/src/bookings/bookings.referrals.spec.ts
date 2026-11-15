/**
 * Реферальные начисления на вердиктах воркера: первая оплаченная бронь
 * приглашённого награждает обе стороны (пригласившему referral, другу
 * referral_welcome), захват «первенца» атомарный, отмена брони гасит
 * обе награды clawback'ом — не в минус, как кэшбэк.
 */
import {
  authUser,
  bookingFixture,
  buildBookingsHarness,
  flushAsync,
} from './bookings.service.harness';

const INVITER = 'inviter-1';

/** друг user-1, приглашённый inviter-1 (default: награда ещё не отдана) */
function invitedFriend(rewarded = false) {
  return {
    id: authUser.id,
    referredBy: INVITER,
    referralRewardedAt: rewarded ? new Date() : null,
  };
}

function confirmedEvent() {
  return {
    bookingId: 'booking-1',
    status: 'CONFIRMED' as const,
    message: 'Оплата прошла',
    processedBy: 'go-worker-1',
    processedAt: '2026-09-03T12:00:05Z',
  };
}

/** харнесс с бронью по умолчанию: вердикты находят PENDING-фикстуру */
async function harness() {
  const h = await buildBookingsHarness();
  h.bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());
  return h;
}

describe('BookingsService: реферальные бонусы', () => {
  it('первая оплаченная бронь друга: referral пригласившему, welcome другу, метка занята', async () => {
    const h = await harness();
    h.usersRows.push(invitedFriend());

    await h.service.handleProcessed(confirmedEvent());
    await flushAsync();

    const byReason = (reason: string) =>
      h.bonusRows.filter((r) => r.reason === reason);
    // кэшбэк 5% от 1200 — как обычно, поверх реферальных
    expect(byReason('cashback')).toHaveLength(1);
    expect(byReason('referral')).toEqual([
      { userId: INVITER, bookingId: 'booking-1', kind: 'accrual', reason: 'referral', amount: 300 },
    ]);
    expect(byReason('referral_welcome')).toEqual([
      { userId: authUser.id, bookingId: 'booking-1', kind: 'accrual', reason: 'referral_welcome', amount: 100 },
    ]);
    expect(h.usersRows[0].referralRewardedAt).not.toBeNull();
  });

  it('метка уже занята (вторая бронь друга / ределивери) — только кэшбэк', async () => {
    const h = await harness();
    h.usersRows.push(invitedFriend(true));

    await h.service.handleProcessed(confirmedEvent());
    await flushAsync();

    expect(h.bonusRows.filter((r) => r.reason === 'referral')).toHaveLength(0);
    expect(h.bonusRows.filter((r) => r.reason === 'referral_welcome')).toHaveLength(0);
    expect(h.bonusRows.filter((r) => r.reason === 'cashback')).toHaveLength(1);
  });

  it('друг пришёл сам по себе (referred_by пуст) — реферальных нет', async () => {
    const h = await harness();
    h.usersRows.push({
      id: authUser.id,
      referredBy: null,
      referralRewardedAt: null,
    });

    await h.service.handleProcessed(confirmedEvent());
    await flushAsync();

    expect(
      h.bonusRows.filter((r) => r.reason.startsWith('referral')),
    ).toHaveLength(0);
  });

  it('отмена награждённой брони: clawback обеим сторонам, метка первая-оплата остаётся занятой', async () => {
    const h = await harness();
    h.usersRows.push(invitedFriend());

    await h.service.handleProcessed(confirmedEvent());
    await flushAsync();

    // отмена: бронь в CANCELLING, воркер подтвердил возврат
    h.bookingsRepo.findOneByOrFail.mockResolvedValue({
      ...bookingFixture(),
      status: 'CANCELLING',
      bonusSpent: null,
    });
    await h.service.handleRefunded({
      bookingId: 'booking-1',
      status: 'CANCELLED' as const,
      message: 'Возврат исполнен',
      processedBy: 'go-worker-1',
      processedAt: '2026-09-03T12:30:00Z',
    });
    await flushAsync();

    const clawbacks = h.bonusRows.filter((r) => r.reason === 'clawback');
    // другу гасятся кэшбэк+welcome одной строкой, пригласившему — referral
    expect(clawbacks).toHaveLength(2);
    expect(clawbacks.find((c) => c.userId === authUser.id)).toMatchObject({
      amount: 60 + 100, // кэшбэк 60 + welcome 100, баланс позволяет
    });
    expect(clawbacks.find((c) => c.userId === INVITER)).toMatchObject({
      amount: 300,
    });
    // награда сгорела вместе с первой бронью — метку не откатываем
    expect(h.usersRows[0].referralRewardedAt).not.toBeNull();
  });

  it('пригласивший успел потратить награду — гасим сколько есть, не в минус', async () => {
    const h = await harness();
    h.usersRows.push(invitedFriend());

    await h.service.handleProcessed(confirmedEvent());
    await flushAsync();
    // пригласивший потратил всё реферальное на другую бронь
    h.bonusRows.push({
      userId: INVITER,
      bookingId: 'booking-9',
      kind: 'spend',
      reason: 'payment',
      amount: 300,
    });

    h.bookingsRepo.findOneByOrFail.mockResolvedValue({
      ...bookingFixture(),
      status: 'CANCELLING',
      bonusSpent: null,
    });
    await h.service.handleRefunded({
      bookingId: 'booking-1',
      status: 'CANCELLED' as const,
      message: 'Возврат исполнен',
      processedBy: 'go-worker-1',
      processedAt: '2026-09-03T12:30:00Z',
    });
    await flushAsync();

    const inviterClawback = h.bonusRows.find(
      (r) => r.reason === 'clawback' && r.userId === INVITER,
    );
    expect(inviterClawback).toBeUndefined(); // баланс 0 — прощаем
  });
});
