import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { BarItemDto } from './bar-item.entity';
import { BarService } from './bar.service';

/**
 * Кинобар: витрина каталога доступна без авторизации, заказы — за JWT
 * (об оформлении и статусах — следующие маршруты модуля bar).
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
}
