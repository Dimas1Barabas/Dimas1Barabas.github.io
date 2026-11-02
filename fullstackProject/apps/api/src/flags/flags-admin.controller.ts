import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { AuthUser } from '../auth/auth-user';
import { FlagUpsertDto } from './dto/flag-upsert.dto';
import { FlagsEvaluator } from './flags.evaluator';
import { FlagsClient } from './flags.client';
import { FlagsRevisionsClient } from './flags-revisions.client';

/**
 * Админка тумблеров фич: витрина состояний, правки (процент раскатки,
 * мастер-тумблер, kill-switch) и аудит. Мутации идут в «Суфлёр» от имени
 * админа (updatedBy = email из JWT) — аудит правок в сервисе честный.
 */
@ApiTags('admin/flags')
@Roles('admin')
@Controller('admin/flags')
export class FlagsAdminController {
  private readonly logger = new Logger('FlagsAdminController');

  constructor(
    private readonly evaluator: FlagsEvaluator,
    private readonly client: FlagsClient,
    private readonly revisions: FlagsRevisionsClient,
  ) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Витрина флагов фич (админка)',
    description:
      'Снимки всех тумблеров: состояние, процент раскатки, kill-switch, ' +
      'последняя правка. Источник — кэш состояний API (TTL 5 c).',
  })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  async list() {
    return { flags: await this.evaluator.list() };
  }

  @Patch(':key')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Создать/обновить флаг (админка)',
    description:
      'Полное новое состояние тумблера: процент раскатки, мастер-тумблер, ' +
      'kill-switch. Правка уходит в сервис от имени админа и попадает в аудит.',
  })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  async upsert(
    @Param('key') key: string,
    @Body() dto: FlagUpsertDto,
    @Req() req: { user: AuthUser },
  ) {
    try {
      const flag = await this.client.upsertFlag({
        key: dto.key ?? key,
        description: dto.description,
        enabled: dto.enabled,
        percentage: dto.percentage,
        killed: dto.killed,
        updatedBy: req.user?.email ?? 'admin',
      });
      // правка только что случилась — кэш может ещё жить по TTL, инвалидируем
      await this.evaluator.refresh();
      return flag;
    } catch (err) {
      this.logger.warn(`upsert ${key}: ${String(err)}`);
      throw new HttpException(
        'Суфлёр недоступен — правка не сохранена',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Delete(':key')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Удалить флаг (админка)',
    description:
      'Evaluate начнёт отвечать not_found (фича скрыта). Аудит правок ' +
      'переживает удаление.',
  })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  async remove(@Param('key') key: string) {
    try {
      const res = await this.client.deleteFlag(key);
      await this.evaluator.refresh();
      return { deleted: res.deleted ?? false };
    } catch (err) {
      this.logger.warn(`delete ${key}: ${String(err)}`);
      throw new HttpException(
        'Суфлёр недоступен — флаг не удалён',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  @Get(':key/revisions')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Аудит правок флага (админка)',
    description:
      'История правок свежими сверху: кто, когда и каким снимком менял ' +
      'тумблер. Живёт в HTTP-витрине сервиса, переживает удаление флага.',
  })
  @ApiOkResponse()
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  async history(@Param('key') key: string) {
    return { revisions: await this.revisions.revisions(key) };
  }
}
