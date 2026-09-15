import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { toUserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { Public } from './public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

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
  async register(@Body() dto: RegisterDto) {
    return toUserDto(await this.users.register(dto));
  }

  /** вход: {accessToken, user}; токен живёт 2 часа. @Public — по той же причине */
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
}
