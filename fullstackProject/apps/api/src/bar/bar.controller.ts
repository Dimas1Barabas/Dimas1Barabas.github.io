import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { Public } from '../auth/public.decorator';
import { BarItemDto } from './bar-item.entity';
import { BarOrderDto } from './bar-order.entity';
import { CreateBarOrderDto } from './dto/create-bar-order.dto';
import { BarService } from './bar.service';

/**
 * Кинобар: витрина каталога доступна без авторизации, заказы — за JWT.
 * Статусы приготовления («мои заказы» и отмена) — следующие маршруты.
 */
@ApiTags('bar')
@Controller('bar')
export class BarController {
  constructor(private readonly bar: BarService) {}

  /** витрина: каталог кинобара с остатками */
  @Public()
  @Get('menu')
  @ApiOperation({
    summary: 'Каталог кинобара с остатками',
    description:
      'Активные позиции по порядку витрины: попкорн → напитки → снеки → ' +
      'комбо. Остаток виден честно («осталось 3»), 0 — продано; заказ ' +
      'спишет остаток атомарно, при нехватке вернёт 409 OUT_OF_STOCK.',
  })
  @ApiOkResponse({ type: [BarItemDto] })
  menu(): Promise<BarItemDto[]> {
    return this.bar.menu();
  }

  /** оформить предзаказ (оплата на кассе при получении) */
  @Post('orders')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Оформить предзаказ кинобара',
    description:
      'Списывает остатки атомарно (UPDATE … WHERE stock >= qty — гонку за ' +
      'последнюю порцию решает СУБД), фиксирует снимки цен и ставит заказ ' +
      'в очередь Бармена. Нехватка остатка — 409 с честным количеством; ' +
      'несуществующий сеанс — 404.',
  })
  @ApiCreatedResponse({ type: BarOrderDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiConflictResponse({
    description: 'Позиции не хватает на складе (message — сколько осталось)',
  })
  create(
    @Body() dto: CreateBarOrderDto,
    @Req() req: { user: AuthUser },
  ): Promise<BarOrderDto> {
    return this.bar.create(dto, req.user);
  }

  /** «Мои заказы»: статусы приготовления приходят от Бармена */
  @Get('orders/my')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Мои заказы кинобара',
    description:
      'Заказы пользователя свежие сверху: статус (NEW → PREPARING → ' +
      'READY → PICKED_UP / CANCELLED — переходы гоняет Бармен), состав со ' +
      'снимками цен, сумма и сеанс, к которому заказ (если указан).',
  })
  @ApiOkResponse({ type: [BarOrderDto] })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  my(@Req() req: { user: AuthUser }): Promise<BarOrderDto[]> {
    return this.bar.my(req.user);
  }

  /** отменить заказ, пока Бармен не выдал его */
  @Post('orders/:id/cancel')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Отменить заказ кинобара',
    description:
      'Доступна на NEW/PREPARING: порции возвращаются на склад той же ' +
      'транзакцией, Бармен убирает заказ из очереди. Выданный (READY после ' +
      'приёмки/PICKED_UP) и уже отменённый заказ отменить нельзя — 409.',
  })
  @ApiOkResponse({ type: BarOrderDto, description: 'Отменённый заказ' })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Заказ принадлежит другому пользователю' })
  @ApiNotFoundResponse({ description: 'Заказ не найден' })
  @ApiConflictResponse({
    description: 'Заказ уже выдан или уже отменён',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: AuthUser },
  ): Promise<BarOrderDto> {
    return this.bar.cancel(id, req.user);
  }
}
