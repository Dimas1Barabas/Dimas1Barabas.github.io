/**
 * FraudAdminController (unit): витрина решений и резолвы ревью. Клиенты
 * и BookingsService — моки: здесь проверяется оркестрация (порядок
 * «сначала аудит в детективе, потом бизнес-шаг») и маппинг ошибок.
 */
import { HttpException } from '@nestjs/common';
import { AuthUser } from '../auth/auth-user';
import { BookingsService } from '../bookings/bookings.service';
import { DetectiveClient } from './detective.client';
import { DetectiveShowcaseClient } from './detective-showcase.client';
import { FraudAdminController } from './fraud-admin.controller';

const adminReq: { user: AuthUser } = {
  user: { id: 'admin-1', email: 'admin@test.local', name: 'Админ', role: 'admin' },
};

/** gRPC-ошибка детектива в мирографии grpc-js (объект с message) */
function grpcError(message: string): Error {
  return Object.assign(new Error(message), {});
}

function build(opts?: {
  resolve?: jest.Mock;
  decisions?: jest.Mock;
  payReviewed?: jest.Mock;
  cancelReviewed?: jest.Mock;
}) {
  const showcase = {
    decisions: opts?.decisions ?? jest.fn(async () => []),
  } as unknown as DetectiveShowcaseClient;
  const detective = {
    resolve:
      opts?.resolve ??
      jest.fn(async () => ({ resolved: true, status: 'approved' })),
  } as unknown as DetectiveClient;
  const bookings = {
    payReviewed: opts?.payReviewed ?? jest.fn(async () => ({ id: 'b-1', status: 'PENDING' })),
    cancelReviewed: opts?.cancelReviewed ?? jest.fn(async () => ({ id: 'b-1', status: 'CANCELLED' })),
  } as unknown as BookingsService;
  return {
    controller: new FraudAdminController(showcase, detective, bookings),
    showcase,
    detective,
    bookings,
  };
}

describe('FraudAdminController (unit)', () => {
  it('витрина отдаёт решения с фильтром статуса', async () => {
    const decisions = jest.fn(async () => [{ bookingId: 'b-1', status: 'pending_review' }]);
    const { controller } = build({ decisions });

    const res = await controller.list('pending_review');

    expect(res.decisions).toEqual([{ bookingId: 'b-1', status: 'pending_review' }]);
    expect(decisions).toHaveBeenCalledWith('pending_review');
  });

  it('approve: сначала аудит в детективе, затем системная оплата', async () => {
    const resolve = jest.fn(async () => ({ resolved: true, status: 'approved' }));
    const payReviewed = jest.fn(async () => ({ id: 'b-1', status: 'PENDING' }));
    const { controller } = build({ resolve, payReviewed });

    const res = await controller.resolve('b-1', { action: 'approve' }, adminReq);

    expect(res).toMatchObject({ resolved: 'approved' });
    expect(resolve).toHaveBeenCalledWith({
      bookingId: 'b-1',
      action: 'approve',
      resolvedBy: 'admin@test.local',
    });
    expect(payReviewed).toHaveBeenCalledWith('b-1');
  });

  it('reject: отмена возвращает места, решение зафиксировано', async () => {
    const resolve = jest.fn(async () => ({ resolved: true, status: 'rejected' }));
    const cancelReviewed = jest.fn(async () => ({ id: 'b-1', status: 'CANCELLED' }));
    const { controller } = build({ resolve, cancelReviewed });

    const res = await controller.resolve('b-1', { action: 'reject' }, adminReq);

    expect(res).toMatchObject({ resolved: 'rejected', booking: { status: 'CANCELLED' } });
    expect(cancelReviewed).toHaveBeenCalledWith('b-1');
  });

  it('решение не найдено — 404 fraudDecisionNotFound, бизнес не трогаем', async () => {
    const resolve = jest.fn(() => Promise.reject(grpcError('3 NOT_FOUND: решение не найдено')));
    const payReviewed = jest.fn();
    const { controller } = build({ resolve, payReviewed });

    const promise = controller.resolve('nope', { action: 'approve' }, adminReq);

    await expect(promise).rejects.toBeInstanceOf(HttpException);
    const err = (await promise.catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(404);
    expect(err.getResponse()).toMatchObject({ code: 'fraudDecisionNotFound' });
    expect(payReviewed).not.toHaveBeenCalled();
  });

  it('уже решено (гонка админов) — 409 fraudAlreadyResolved', async () => {
    const resolve = jest.fn(() =>
      Promise.reject(grpcError('9 FAILED_PRECONDITION: решение уже закрыто')),
    );
    const { controller } = build({ resolve });

    const promise = controller.resolve('b-1', { action: 'approve' }, adminReq);

    const err = (await promise.catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'fraudAlreadyResolved' });
  });

  it('бронь истекла за время ревью: оплата отказала — 409 fraudResolveConflict, аудит цел', async () => {
    const resolve = jest.fn(async () => ({ resolved: true, status: 'approved' }));
    const payReviewed = jest.fn(() =>
      Promise.reject(
        new HttpException(
          { statusCode: 409, message: 'истекла', status: 'EXPIRED' },
          409,
        ),
      ),
    );
    const { controller } = build({ resolve, payReviewed });

    const promise = controller.resolve('b-1', { action: 'approve' }, adminReq);

    const err = (await promise.catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'fraudResolveConflict' });
    // решение в детективе уже записано — второй резолв получит AlreadyResolved
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('reject по истёкшей брони: cancelReviewed вернул null — 409', async () => {
    const resolve = jest.fn(async () => ({ resolved: true, status: 'rejected' }));
    const cancelReviewed = jest.fn(async () => null);
    const { controller } = build({ resolve, cancelReviewed });

    const promise = controller.resolve('b-1', { action: 'reject' }, adminReq);

    const err = (await promise.catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'fraudResolveConflict' });
  });

  it('детектив недоступен — 502, решение не зафиксировано', async () => {
    const resolve = jest.fn(() => Promise.reject(grpcError('14 UNAVAILABLE: connection refused')));
    const { controller } = build({ resolve });

    const promise = controller.resolve('b-1', { action: 'approve' }, adminReq);

    const err = (await promise.catch((e: unknown) => e)) as HttpException;
    expect(err.getStatus()).toBe(502);
  });
});
