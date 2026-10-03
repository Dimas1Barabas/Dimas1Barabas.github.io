import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';

/**
 * EntityNotFoundError → 404: findOneByOrFail на пути HTTP-запроса — это
 * «сущности нет», а не серверная ошибка. Без фильтра pay/цена сеанса по
 * несуществующему id отдавали 500 при задокументированном 404 (поймано
 * живым e2e-стендом в CI: оба негатива падали в ExceptionsHandler).
 *
 * Только HTTP: консьюмеры Rabbit poisoned-маркировку NotFoundException
 * не затрагивает — их ошибки идут через errorHandler подписки.
 */
@Catch(EntityNotFoundError)
export class TypeOrmNotFoundFilter implements ExceptionFilter {
  catch(_exception: EntityNotFoundError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse();
    res
      .status(404)
      .json({ statusCode: 404, message: 'Not Found', error: 'Not Found' });
  }
}
