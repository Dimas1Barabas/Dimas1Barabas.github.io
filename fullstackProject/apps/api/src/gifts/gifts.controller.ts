import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { ActivateGiftDto } from './dto/activate-gift.dto';
import { CreateGiftDto } from './dto/create-gift.dto';
import { GiftDto } from './gift-certificate.entity';
import { GiftsMyDto, GiftsService } from './gifts.service';

/**
 * Гифт-сертификаты: покупка номинала → код → активация получателем →
 * частичное списание в оплате брони (BookingsService.pay, после
 * промокода и бонусов) → возврат при отмене/провале оплаты.
 */
@ApiTags('gifts')
@ApiBearerAuth()
@Controller('gifts')
export class GiftsController {
  constructor(private readonly gifts: GiftsService) {}

  @Post()
  @ApiOperation({
    summary: 'Купить сертификат',
    description:
      'Номинал 500–50 000 ₽ кратно 100, срок 365 дней. Возврат — код ' +
      'карты: передайте его получателю, он активирует на этой же ' +
      'странице. Покупатель может активировать карту и сам.',
  })
  @ApiCreatedResponse({ type: GiftDto })
  @ApiBadRequestResponse({ description: 'Номинал вне границ или не кратен 100' })
  purchase(
    @Req() req: { user: AuthUser },
    @Body() dto: CreateGiftDto,
  ): Promise<GiftDto> {
    return this.gifts.purchase(req.user, dto.nominalRub);
  }

  @Post('activate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Активировать код подаренной карты',
    description:
      'Одноразовая атомарная активация: карта привязывается к вашему ' +
      'счёту, остаток виден в GET /gifts/my и тратится в оплате брони. ' +
      'Гонку двух получателей одного кода решает БД — проигравший ' +
      'получит 409 giftAlreadyActivated.',
  })
  @ApiOkResponse({ type: GiftDto })
  @ApiNotFoundResponse({ description: 'Код не найден (giftNotFound)' })
  @ApiGoneResponse({ description: 'Срок карты истёк (giftExpired)' })
  @ApiConflictResponse({
    description: 'Карта уже активирована (giftAlreadyActivated)',
  })
  activate(
    @Req() req: { user: AuthUser },
    @Body() dto: ActivateGiftDto,
  ): Promise<GiftDto> {
    return this.gifts.activate(req.user, dto.code);
  }

  @Get('my')
  @ApiOperation({
    summary: 'Мои сертификаты и итоги',
    description:
      'cards — активированные мной карты (живые и потраченные), ' +
      'given — купленные мной коды, ожидающие получателя, totals — ' +
      'живой остаток availableRub и счётчики.',
  })
  @ApiOkResponse({ type: GiftsMyDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  my(@Req() req: { user: AuthUser }): Promise<GiftsMyDto> {
    return this.gifts.my(req.user);
  }
}
