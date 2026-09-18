import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { Roles } from '../auth/roles.decorator';
import { CreatePromoDto } from './dto/create-promo.dto';
import { ValidatePromoDto } from './dto/validate-promo.dto';
import { PromoDto, PromoPreviewDto } from './promo.entity';
import { PromosService } from './promos.service';

@ApiTags('promos')
@Controller('promos')
export class PromosController {
  constructor(private readonly promos: PromosService) {}

  /** промокоды создаёт администратор */
  @Post()
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Создать промокод',
    description:
      'Процент или фикс в рублях, лимит активаций и срок. ' +
      'Активации списываются атомарно в момент оплаты — гонку за ' +
      'последний код решает БД (см. POST /bookings/:id/pay).',
  })
  @ApiCreatedResponse({ type: PromoDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Нужна роль admin' })
  @ApiConflictResponse({ description: 'Код уже существует — код promoExists' })
  create(@Body() dto: CreatePromoDto): Promise<PromoDto> {
    return this.promos.create(dto);
  }

  @Get()
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Список промокодов',
    description: 'Свежие сверху; счётчик использованных активаций — из БД',
  })
  @ApiOkResponse({ type: [PromoDto] })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Нужна роль admin' })
  list(): Promise<PromoDto[]> {
    return this.promos.list();
  }

  /**
   * Превью без списания: показать покупателю пересчитанную сумму
   * до нажатия «Оплатить». Ошибки — кодами promoNotFound (404),
   * promoExpired (410), promoExhausted (409).
   */
  @Post('validate')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Проверить промокод на брони',
    description:
      'Возвращает скидку и итог по текущей сумме брони. Активация ' +
      'НЕ списывается — код могут исчерпать до оплаты, тогда сам pay ' +
      'ответит 409 promoExhausted.',
  })
  @ApiOkResponse({ type: PromoPreviewDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Чужая бронь' })
  @ApiConflictResponse({
    description: 'Бронь не ждёт оплаты (status) или код исчерпан (promoExhausted)',
  })
  @ApiGoneResponse({ description: 'Срок действия кода истёк — код promoExpired' })
  validate(
    @Body() dto: ValidatePromoDto,
    @Req() req: { user: AuthUser },
  ): Promise<PromoPreviewDto> {
    return this.promos.validate(dto, req.user);
  }
}
