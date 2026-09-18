import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthUser } from '../auth/auth-user';
import { Booking } from '../bookings/booking.entity';
import { CreatePromoDto } from './dto/create-promo.dto';
import { ValidatePromoDto } from './dto/validate-promo.dto';
import { Promo } from './promo.entity';
import { PromosService } from './promos.service';

const authUser: AuthUser = {
  id: 'user-1',
  email: 'dmitry@example.com',
  name: 'Дмитрий',
  role: 'user',
};

function promoFixture(): Promo {
  return {
    id: 'promo-1',
    code: 'CINE10',
    kind: 'percent',
    value: 10,
    maxActivations: 100,
    usedCount: 3,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date('2026-09-19T00:00:00Z'),
    updatedAt: new Date('2026-09-19T00:00:00Z'),
  };
}

function bookingFixture(): Booking {
  return {
    id: 'booking-1',
    movieId: 'movie-1',
    movie: {} as Booking['movie'],
    sessionId: 'session-1',
    session: {} as Booking['session'],
    customerName: 'Дмитрий',
    userId: 'user-1',
    seats: ['5-7'],
    totalRub: 1000,
    promoCode: null,
    discountRub: null,
    status: 'PENDING_PAYMENT',
    expiresAt: null,
    message: null,
    processedBy: null,
    processedAt: null,
    createdAt: new Date('2026-09-19T12:00:00Z'),
    updatedAt: new Date('2026-09-19T12:00:00Z'),
  };
}

function createDto(overrides: Partial<CreatePromoDto> = {}): CreatePromoDto {
  return {
    code: 'cine-10',
    kind: 'percent',
    value: 10,
    maxActivations: 100,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

describe('PromosService (unit)', () => {
  let service: PromosService;
  let promosRepo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOneBy: jest.Mock;
  };
  let bookingsRepo: { findOneByOrFail: jest.Mock };

  beforeEach(async () => {
    promosRepo = {
      create: jest.fn((x: Partial<Promo>) => x),
      // merge с фикстурой эмулирует БД: проставляет id и даты
      save: jest.fn(async (x: Partial<Promo>) => ({ ...promoFixture(), ...x })),
      find: jest.fn(async () => [promoFixture()]),
      findOneBy: jest.fn(async () => promoFixture()),
    };
    bookingsRepo = { findOneByOrFail: jest.fn(async () => bookingFixture()) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PromosService,
        { provide: getRepositoryToken(Promo), useValue: promosRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
      ],
    }).compile();
    service = moduleRef.get(PromosService);
  });

  /** вылавливает HttpException из промиса и отдаёт его статус+тело */
  async function rejection(promise: Promise<unknown>): Promise<{
    status: number;
    body: Record<string, unknown>;
  }> {
    try {
      await promise;
      throw new Error('ожидали ошибку, получили успех');
    } catch (err) {
      const e = err as { getStatus: () => number; getResponse: () => unknown };
      return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
    }
  }

  describe('create', () => {
    it('нормализует код в верхний регистр и возвращает DTO', async () => {
      const dto = await service.create(createDto({ code: '  cine-10 ' }));

      expect(promosRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'CINE-10', usedCount: 0 }),
      );
      // save-мок мерджит вход с фикстурой — код из нормализованного входа
      expect(dto.code).toBe('CINE-10');
    });

    it('409 promoExists при дубле кода (uq-констрейнт)', async () => {
      promosRepo.save.mockRejectedValue({ code: '23505' });

      const { status, body } = await rejection(service.create(createDto()));

      expect(status).toBe(409);
      expect(body.code).toBe('promoExists');
    });

    it('400 на срок действия в прошлом', async () => {
      const { status } = await rejection(
        service.create(
          createDto({ expiresAt: new Date('2020-01-01T00:00:00Z').toISOString() }),
        ),
      );
      expect(status).toBe(400);
    });
  });

  describe('list', () => {
    it('возвращает DTO свежими сверху', async () => {
      const rows = await service.list();

      expect(promosRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].code).toBe('CINE10');
      expect(typeof rows[0].expiresAt).toBe('string');
    });
  });

  describe('validate', () => {
    function validateDto(
      overrides: Partial<ValidatePromoDto> = {},
    ): ValidatePromoDto {
      return { code: 'cine10', bookingId: 'booking-1', ...overrides };
    }

    it('превью процента: скидка и итог', async () => {
      const preview = await service.validate(validateDto(), authUser);

      // промокод ищется нормализованным
      expect(promosRepo.findOneBy).toHaveBeenCalledWith({ code: 'CINE10' });
      expect(preview).toEqual({
        code: 'CINE10',
        kind: 'percent',
        value: 10,
        discountRub: 100,
        totalRub: 900,
      });
    });

    it('фикс больше суммы клампится: итог 0', async () => {
      promosRepo.findOneBy.mockResolvedValue({
        ...promoFixture(),
        kind: 'fixed',
        value: 5000,
      });

      const preview = await service.validate(validateDto(), authUser);

      expect(preview.discountRub).toBe(1000);
      expect(preview.totalRub).toBe(0);
    });

    it('403 на чужую бронь', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        userId: 'user-2',
      });

      const { status } = await rejection(
        service.validate(validateDto(), authUser),
      );
      expect(status).toBe(403);
    });

    it('409 со status, если бронь не ждёт оплаты', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CONFIRMED',
      });

      const { status, body } = await rejection(
        service.validate(validateDto(), authUser),
      );
      expect(status).toBe(409);
      expect(body.status).toBe('CONFIRMED');
    });

    it('404 promoNotFound', async () => {
      promosRepo.findOneBy.mockResolvedValue(null);

      const { status, body } = await rejection(
        service.validate(validateDto(), authUser),
      );
      expect(status).toBe(404);
      expect(body.code).toBe('promoNotFound');
    });

    it('410 promoExpired', async () => {
      promosRepo.findOneBy.mockResolvedValue({
        ...promoFixture(),
        expiresAt: new Date(Date.now() - 1000),
      });

      const { status, body } = await rejection(
        service.validate(validateDto(), authUser),
      );
      expect(status).toBe(410);
      expect(body.code).toBe('promoExpired');
    });

    it('409 promoExhausted', async () => {
      promosRepo.findOneBy.mockResolvedValue({
        ...promoFixture(),
        usedCount: 100,
        maxActivations: 100,
      });

      const { status, body } = await rejection(
        service.validate(validateDto(), authUser),
      );
      expect(status).toBe(409);
      expect(body.code).toBe('promoExhausted');
    });
  });
});
