/**
 * Сага отмены: cancel переводит CONFIRMED → CANCELLING и публикует
 * booking.cancelled для Go-воркера; вердикт booking.refunded гасит места
 * (CANCELLED) или откатывает статус (REFUND_FAILED), ределивери — идемпотентен.
 * Вырезано из большого http.int.spec.ts; бутстрап и фейки — в ./int-harness.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BookingsService } from '../src/bookings/bookings.service';
import { buildHttpIntApp, requestCatalog, type MovieDtoJson } from './int-harness';

describe('CineBooking API: сага отмены (фейковые зависимости)', () => {
  let app: INestApplication;
  let bookingsService: BookingsService;
  let rabbitPublish: jest.Mock;
  /** Authorization: владелец брони */
  let bearer: string;

  let catalog: () => Promise<MovieDtoJson[]>;

  beforeAll(async () => {
    const h = await buildHttpIntApp();
    app = h.app;
    bookingsService = h.bookingsService;
    rabbitPublish = h.rabbitPublish;
    bearer = h.bearer;
    catalog = () => requestCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('сага отмены: возврат через Go-воркера', () => {
    /** создаёт и оплачивает бронь (create → pay → вердикт) — готова к отмене */
    async function confirmedBooking(
      sessionId: string,
      seats: string[],
      name: string,
    ) {
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId,
          customerName: name,
          seats,
        })
      ).body;
      await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);
      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });
      return created;
    }

    it('cancel: CONFIRMED → CANCELLING, публикация booking.cancelled с сеансом', async () => {
      const movies = await catalog();
      const session = movies[3].sessions[0];
      const created = await confirmedBooking(session.id, ['3-5', '3-6'], 'Отмена');

      rabbitPublish.mockClear();
      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLING');
      expect(rabbitPublish).toHaveBeenCalledWith(
        'cinema',
        'booking.cancelled',
        expect.objectContaining({
          bookingId: created.id,
          sessionId: session.id,
          seats: ['3-5', '3-6'],
          totalRub: created.totalRub,
        }),
        expect.objectContaining({ headers: expect.any(Object) }),
      );

      // до вердикта возврата места держатся занятыми
      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toEqual(expect.arrayContaining(['3-5', '3-6']));

      // повторная отмена по CANCELLING — 409: гонку закрыл статус
      const again = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);
      expect(again.status).toBe(409);
    });

    it('booking.refunded CANCELLED → места свободны и снова покупаемы', async () => {
      const movies = await catalog();
      const session = movies[4].sessions[0];
      const created = await confirmedBooking(session.id, ['7-1'], 'Возврат');
      await request(app.getHttpServer()).post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);

      // то, что в реальном стеке делает Go ticket-worker через RabbitMQ
      await bookingsService.handleRefunded({
        bookingId: created.id,
        status: 'CANCELLED',
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (await request(app.getHttpServer()).get('/api/bookings')).body;
      const cancelled = list.find((b: { id: string }) => b.id === created.id);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.message).toContain('Возврат');

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).not.toContain('7-1');

      const rebook = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: session.id, customerName: 'Снова', seats: ['7-1'] });
      expect(rebook.status).toBe(201);
    });

    it('booking.refunded REFUND_FAILED → откат в CONFIRMED, места держатся', async () => {
      const movies = await catalog();
      const session = movies[5].sessions[0];
      const created = await confirmedBooking(session.id, ['8-10'], 'Банк не смог');
      await request(app.getHttpServer()).post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);

      await bookingsService.handleRefunded({
        bookingId: created.id,
        status: 'REFUND_FAILED',
        message: 'Банк отклонил возврат (код 77).',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (await request(app.getHttpServer()).get('/api/bookings')).body;
      const restored = list.find((b: { id: string }) => b.id === created.id);
      expect(restored.status).toBe('CONFIRMED');
      expect(restored.message).toContain('возврат');

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toContain('8-10');
    });

    it('409 на отмену брони в PENDING (платёж уже в полёте)', async () => {
      const movies = await catalog();
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: movies[0].sessions[0].id,
          customerName: 'Нетерпеливый',
          seats: ['1-8'],
        })
      ).body;
      await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/pay`)
        .set('Authorization', bearer);

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ status: 'PENDING' });
    });

    it('404 на отмену несуществующей брони', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings/00000000-0000-0000-0000-000000000000/cancel')
        .set('Authorization', bearer);
      expect(res.status).toBe(404);
    });

    it('ределивери booking.refunded по закрытой саге — без последствий', async () => {
      const movies = await catalog();
      const session = movies[4].sessions[0];
      const created = await confirmedBooking(session.id, ['2-9'], 'Дубль');
      await request(app.getHttpServer()).post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);
      await bookingsService.handleRefunded({
        bookingId: created.id,
        status: 'CANCELLED',
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      // тот же вердикт приходит повторно (например, из-за ретрая)
      await bookingsService.handleRefunded({
        bookingId: created.id,
        status: 'CANCELLED',
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (await request(app.getHttpServer()).get('/api/bookings')).body;
      const cancelled = list.find((b: { id: string }) => b.id === created.id);
      expect(cancelled.status).toBe('CANCELLED');

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).not.toContain('2-9');
    });
  });
});
