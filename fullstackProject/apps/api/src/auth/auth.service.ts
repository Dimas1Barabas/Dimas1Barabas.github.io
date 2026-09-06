import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { toUserDto, UserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';

export interface LoginResult {
  accessToken: string;
  user: UserDto;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  /** вход: сверяем bcrypt-хэш, выдаём JWT с клеймами пользователя */
  async login(input: { email: string; password: string }): Promise<LoginResult> {
    const user = await this.users.findByEmail(input.email);
    // одинаково отвечаем на «нет такого» и «не тот пароль» — не раскрываем, в чём дело
    if (
      !user ||
      !(await bcrypt.compare(input.password, user.passwordHash))
    ) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    return { accessToken, user: toUserDto(user) };
  }
}
