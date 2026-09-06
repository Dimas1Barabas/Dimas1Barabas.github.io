import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { toUserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly users: UsersService) {}

  /** регистрация: пароль хэшируется, наружу — UserDto без хэша */
  @Post('register')
  @HttpCode(201)
  async register(@Body() dto: RegisterDto) {
    return toUserDto(await this.users.register(dto));
  }
}
