/**
 * Интеграционные (HTTP): мгновенный чекаут POST /api/bookings/checkout —
 * первый маршрут за тумблером «Суфлёра» (checkout.new_flow). Полный стек
 * как в бою: JWT-гвард → лимиты → FeatureFlagGuard → контроллер → сервис.
 * Вердикт флага переключается фейком эвалюатора из int-harness.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  buildHttpIntApp,
  requestCatalog,
  type IntAppContext,
  type MovieDtoJson,
} from './int-harness';

describe('POST /api/bookings/checkout за флагом checkout.new_flow (int)', () => {
  let app: INestApplication;
  let ctx: IntAppContext;
  let bearer: string;
  let session: MovieDtoJson['sessions'][number];

  beforeAll(async () => {
    ctx = await buildHttpIntApp();
    app = ctx.app;
    bearer = ctx.bearer;
    const movies = await requestCatalog(app);
    session = movies[0].sessions[0];
  });

  afterAll(async () => {
    await app.close();
  });

  it('вне раскатки маршрут скрыт: 403 featureDisabled, бронь не создаётся', async () => {
    ctx.flagsEvaluator.isEnabled.mockResolvedValue({
      enabled: false,
      reason: 'off',
      percentage: 0,
      variant: '',
    });

    const res = await request(app.getHttpServer())
      .post('/api/bookings/checkout')
      .set('Authorization', bearer)
      .send({ sessionId: session.id, seats: ['5-7'] });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'featureDisabled',
      flag: 'checkout.new_flow',
      reason: 'off',
    });
    // сущность бакетинга — id пользователя из JWT (не email и не ip)
    expect(ctx.flagsEvaluator.isEnabled).toHaveBeenCalledWith(
      'checkout.new_flow',
      'user-a',
    );
    expect(ctx.bookingsRepo.rows).toHaveLength(0);
    expect(ctx.outboxRows).toHaveLength(0);
  });

  it('флаг включён: 201, бронь сразу в PENDING — воркеру ушёл платёж', async () => {
    ctx.flagsEvaluator.isEnabled.mockResolvedValue({
      enabled: true,
      reason: 'on',
      percentage: 100,
      variant: '',
    });

    const res = await request(app.getHttpServer())
      .post('/api/bookings/checkout')
      .set('Authorization', bearer)
      .send({ sessionId: session.id, seats: ['4-4'] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING', seats: ['4-4'] });
    // один клиентский вызов — обе записи: таймер резерва и запуск платежа
    expect(ctx.outboxRows.map((r) => r.routingKey)).toEqual([
      'booking.payment.wait',
      'booking.created',
    ]);
    expect(ctx.bookingsRepo.rows[0].status).toBe('PENDING');
    // покупка за флагом состоялась — конверсия эксперимента той же сущностью
    expect(ctx.flagsEvaluator.reportConversion).toHaveBeenCalledWith(
      'checkout.new_flow',
      'user-a',
    );
  });

  it('включён, но промокод не найден: 404, бронь осталась в PENDING_PAYMENT', async () => {
    ctx.flagsEvaluator.reportConversion.mockClear();
    ctx.flagsEvaluator.isEnabled.mockResolvedValue({
      enabled: true,
      reason: 'on',
      percentage: 100,
      variant: '',
    });

    const res = await request(app.getHttpServer())
      .post('/api/bookings/checkout')
      .set('Authorization', bearer)
      .send({ sessionId: session.id, seats: ['6-6'], promoCode: 'NOPE10' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'promoNotFound' });
    // отказ оплаты не прячет бронь: она ждёт отдельной оплаты старым флоу
    expect(ctx.bookingsRepo.rows).toHaveLength(2);
    expect(ctx.bookingsRepo.rows[0].status).toBe('PENDING_PAYMENT');
    expect(ctx.outboxRows.map((r) => r.routingKey)).toEqual([
      'booking.payment.wait',
      'booking.created',
      'booking.payment.wait',
    ]);
    // оплата не состоялась — конверсии эксперимента нет
    expect(ctx.flagsEvaluator.reportConversion).not.toHaveBeenCalled();
  });
});
