import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { toUserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  /** регистрация: пароль хэшируется, наружу — UserDto без хэша */
  @Post('register')
  @HttpCode(201)
  async register(@Body() dto: RegisterDto) {
    return toUserDto(await this.users.register(dto));
  }

  /** вход: {accessToken, user}; токен живёт 2 часа */
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }
}
