import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { BookingsService } from '../bookings/bookings.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { GroupsService, JoinGroupResult } from './groups.service';

/**
 * REST-контроллер групп «Идём вместе»: создание (инвайт-ссылка строится
 * на фронте из кода) и публичное превью по коду — его показывает страница
 * приглашения до ввода имени. Живая часть (выбор/готовность/фиксация)
 * живёт в WS-гейтвее /api/groups.
 *
 * Публичен как гостевая броня: участник — имя без логина.
 */
@Public()
@ApiTags('groups')
@Controller('groups')
export class GroupsController {
  constructor(
    private readonly groups: GroupsService,
    private readonly bookings: BookingsService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Создать группу на сеанс',
    description:
      'Создатель становится первым участником. Ответ содержит код-приглашение ' +
      'и participantId — личность для WS-реконнектов. Дальше — WS /api/groups.',
  })
  async create(@Body() dto: CreateGroupDto): Promise<JoinGroupResult> {
    // несуществующий сеанс — 404, как у карты мест (группе не вокруг чего собираться)
    await this.bookings.seatMap(dto.sessionId);
    return this.groups.create(dto.sessionId, dto.name);
  }

  @Get(':code')
  @ApiOperation({
    summary: 'Превью группы по коду-приглашению',
    description:
      'Публичное состояние для страницы приглашения: сколько участников, ' +
      'готовы ли, до какого времени живёт группа.',
  })
  async preview(
    @Param('code') code: string,
  ): Promise<JoinGroupResult['state']> {
    const state = this.groups.snapshot(code);
    if (!state) throw new NotFoundException('Группа не найдена или распалась');
    return state;
  }
}
