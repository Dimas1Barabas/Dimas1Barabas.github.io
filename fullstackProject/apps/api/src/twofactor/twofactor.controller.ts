import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { TwoFactorCodeDto } from './two-factor-code.dto';
import {
  TwoFactorService,
  TwoFactorSetupDto,
  TwoFactorStatusDto,
  TrustedDeviceDto,
} from './twofactor.service';

/** ответ enable: backup-коды показываются ровно один раз */
export class TwoFactorEnabledDto {
  @ApiProperty({
    type: [String],
    example: ['AB2C-3DEF', 'GH4J-5KLM'],
    description: 'backup-коды: покажите и сохраните — повторно не выдаются',
  })
  backupCodes!: string[];
}

/**
 * Управление 2FA из профиля. Все маршруты за глобальным JWT-гвардом,
 * владелец — из клейма токена. Второй шаг логина живёт в AuthController
 * (POST /auth/login/2fa) — это про вход, а не про настройки.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users/me/2fa')
export class TwoFactorController {
  constructor(private readonly twofactor: TwoFactorService) {}

  @Get()
  @ApiOperation({ summary: 'Статус 2FA' })
  @ApiOkResponse({ type: TwoFactorStatusDto })
  async status(@Req() req: { user: AuthUser }): Promise<TwoFactorStatusDto> {
    return this.twofactor.status(req.user);
  }

  @Post('setup')
  @ApiOperation({
    summary: 'Настроить: новый секрет и otpauth-ссылка для QR',
    description:
      'Секрет не включает 2FA — включение подтверждается кодом из приложения. ' +
      'Повторный setup до включения перегенерирует секрет',
  })
  @ApiCreatedResponse({ type: TwoFactorSetupDto })
  @ApiConflictResponse({ description: '2FA уже включена (twoFactorAlreadyOn)' })
  async setup(@Req() req: { user: AuthUser }): Promise<TwoFactorSetupDto> {
    return this.twofactor.setup(req.user);
  }

  @Post('enable')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Включить кодом из приложения',
    description: 'В ответе — backup-коды: показываются один раз',
  })
  @ApiOkResponse({ type: TwoFactorEnabledDto })
  @ApiUnauthorizedResponse({ description: 'Неверный код (totpInvalid)' })
  async enable(
    @Req() req: { user: AuthUser },
    @Body() dto: TwoFactorCodeDto,
  ): Promise<TwoFactorEnabledDto> {
    return { backupCodes: await this.twofactor.enable(req.user, dto.code) };
  }

  @Post('disable')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Выключить кодом приложения или backup-кодом',
    description: 'Гасит секрет, backup-коды и доверенные устройства',
  })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: 'Неверный код (totpInvalid)' })
  async disable(
    @Req() req: { user: AuthUser },
    @Body() dto: TwoFactorCodeDto,
  ): Promise<void> {
    await this.twofactor.disable(req.user, dto.code);
  }

  @Get('devices')
  @ApiOperation({ summary: 'Доверенные устройства' })
  @ApiOkResponse({ type: [TrustedDeviceDto] })
  async devices(@Req() req: { user: AuthUser }): Promise<TrustedDeviceDto[]> {
    return this.twofactor.listDevices(req.user.id);
  }

  @Delete('devices/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Отозвать доверенное устройство' })
  @ApiNoContentResponse()
  async revokeDevice(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
  ): Promise<void> {
    await this.twofactor.revokeDevice(req.user.id, id);
  }
}
