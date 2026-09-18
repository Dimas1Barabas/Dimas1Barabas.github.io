import {
  Body,
  Controller,
  HttpCode,
  Patch,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser } from '../auth/auth-user';
import { LoginResult } from '../auth/auth.service';
import { setRefreshCookie } from '../tokens/cookies';
import { TokensService } from '../tokens/tokens.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

/**
 * Первый контроллер users: личный кабинет. Оба маршрута за глобальным
 * JWT-гвардом (без @Public), владелец — из клеймов токена, не из тела.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
  ) {}

  /**
   * Профиль: имя и/или email. Ответ — свежая JWT-пара: в access-клеймах
   * живут email и name, старый токен протух бы со старыми значениями.
   */
  @Patch('me')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Профиль: имя/email',
    description:
      'Ответ — LoginResult со свежей парой: access несёт новые email/name. ' +
      'Refresh-сессия ротируется в cookie',
  })
  @ApiOkResponse({ type: LoginResult })
  @ApiConflictResponse({ description: 'Email уже занят (код emailTaken)' })
  async updateMe(
    @Body() dto: UpdateProfileDto,
    @Req() req: { user: AuthUser },
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const user = await this.users.updateProfile(req.user.id, dto);
    const pair = await this.tokens.issuePair(user);
    setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, user: pair.user };
  }

  /**
   * Смена пароля: выход отовсюду (все refresh-сессии отозваны), но
   * это устройство сразу получает новую пару — перелогин не нужен.
   */
  @Put('me/password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Смена пароля',
    description:
      'Старый пароль обязателен (403 при неверном). Все прежние ' +
      'refresh-сессии отзываются, ответ — новая пара этого устройства',
  })
  @ApiOkResponse({ type: LoginResult })
  @ApiForbiddenResponse({ description: 'Неверный текущий пароль' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @Req() req: { user: AuthUser },
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const user = await this.users.changePassword(
      req.user.id,
      dto.currentPassword,
      dto.newPassword,
    );
    await this.tokens.revokeAllForUser(user.id);
    const pair = await this.tokens.issuePair(user);
    setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, user: pair.user };
  }
}
