import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiConflictResponse, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { toUserDto, UserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
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

  /** вход: {accessToken, user}; токен живёт 2 часа. @Public — по той же причине */
  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Вход', description: 'Верным ответом на «нет такого» и «не тот пароль» не раскрываем, в чём дело' })
  @ApiOkResponse({ type: LoginResult })
  @ApiUnauthorizedResponse({ description: 'Неверный email или пароль' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
}
