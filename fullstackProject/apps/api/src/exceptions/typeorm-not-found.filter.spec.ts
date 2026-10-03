import { ArgumentsHost } from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';
import { TypeOrmNotFoundFilter } from './typeorm-not-found.filter';

/**
 * Маппинг EntityNotFoundError → 404: findOneByOrFail на HTTP-пути
 * обязан отдавать «не найдено», а не 500 (регрессия живого e2e-стенда:
 * pay и цена сеанса по несуществующему id светились в ExceptionsHandler).
 */

function makeHost(): { host: ArgumentsHost; res: { status: jest.Mock; json: jest.Mock } } {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

describe('TypeOrmNotFoundFilter', () => {
  const filter = new TypeOrmNotFoundFilter();

  it('EntityNotFoundError → 404 со стандартным телом NotFound', () => {
    const { host, res } = makeHost();
    const error = new EntityNotFoundError(Booking, { id: 'missing' });

    filter.catch(error, host);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 404,
      message: 'Not Found',
      error: 'Not Found',
    });
  });
});

// минимум типа для конструктора ошибки — сам класс не важен
class Booking {
  id!: string;
}
