import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  setRefreshCookie,
} from '../tokens/cookies';
import { toUserDto, UserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthUser } from './auth-user';
import { AuthService, LoginResult } from './auth.service';
import { Public } from './public.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Регистрация: пароль хэшируется, наружу — UserDto без хэша.
   * @Public обязателен: гвард глобальный (deny by default), а токена
   * у незарегистрированного ещё нет — вход начинается здесь.
   */
  @Public()
  @Post('register')
  @HttpCode(201)
  @ApiOperation({ summary: 'Регистрация', description: 'Пароль хэшируется bcrypt; наружу — UserDto без хэша' })
  @ApiCreatedResponse({ type: UserDto })
  @ApiConflictResponse({ description: 'Email уже занят (код emailTaken)' })
  async register(@Body() dto: RegisterDto) {
    return toUserDto(await this.users.register(dto));
  }

  /**
   * Вход: {accessToken, user}; refresh-сессия (30 дней) уезжает в
   * httpOnly-cookie cine.refresh — в теле ответа её нет.
   * @Public — как у регистрации: токена ещё нет.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Вход',
    description:
      'Верным ответом на «нет такого» и «не тот пароль» не раскрываем, в чём дело. ' +
      'Refresh-токен выдаётся httpOnly-cookie (Path=/api/auth, 30 дней)',
  })
  @ApiOkResponse({ type: LoginResult })
  @ApiUnauthorizedResponse({ description: 'Неверный email или пароль' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const pair = await this.auth.login(dto);
    setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, user: pair.user };
  }

  /**
   * Обновление сессии по httpOnly-cookie: протухший accessToken
   * продлевается без повторного входа. Ротация: старый refresh гасится,
   * переиспользование отозванного ревокает все сессии пользователя.
   * @Public: протухший access сюда и не доехал бы.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Обновление сессии (refresh-ротация)',
    description:
      'Refresh-токен читается из httpOnly-cookie cine.refresh и ротируется в ответе',
  })
  @ApiOkResponse({ type: LoginResult })
  @ApiUnauthorizedResponse({ description: 'Сессия недействительна или истекла' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult> {
    const pair = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE]);
    setRefreshCookie(res, pair.refreshToken);
    return { accessToken: pair.accessToken, user: pair.user };
  }

  /** выход: гасим refresh-сессию и снимаем куку */
  @Post('logout')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Выход',
    description: 'Гасит refresh-сессию из cookie и снимает её',
  })
  @ApiNoContentResponse()
  async logout(
    @Req() req: Request & { user: AuthUser },
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE], req.user.id);
    clearRefreshCookie(res);
  }
}
