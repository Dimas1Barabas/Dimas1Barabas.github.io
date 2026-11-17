import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
}
