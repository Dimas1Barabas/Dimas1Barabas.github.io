import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { SessionPair, TokensService } from '../tokens/tokens.service';
import { toUserDto, UserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответа логина */
export class LoginResult {
  @ApiProperty({ description: 'Bearer-JWT, живёт 2 часа' })
  accessToken!: string;

  @ApiProperty({ type: UserDto })
  user!: UserDto;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
  ) {}

  /** вход: сверяем bcrypt-хэш, выдаём пару (refresh уедет в httpOnly-cookie) */
  async login(input: { email: string; password: string }): Promise<SessionPair> {
    const user = await this.users.findByEmail(input.email);
    // одинаково отвечаем на «нет такого» и «не тот пароль» — не раскрываем, в чём дело
    if (
      !user ||
      !(await bcrypt.compare(input.password, user.passwordHash))
    ) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    return this.tokens.issuePair(user);
  }

  /**
   * Обновление сессии: refresh из cookie. Ротация внутри: старый токен
   * гасится, переиспользование отозванного убивает все сессии юзера.
   */
  async refresh(refreshToken: string | undefined): Promise<SessionPair> {
    if (!refreshToken) {
      throw new UnauthorizedException('Сессия недействительна');
    }
    const userId = await this.tokens.consume(refreshToken);
    return this.tokens.issuePair(await this.users.findById(userId));
  }

  /** выход: гасим refresh-сессию (куку снимет контроллер) */
  async logout(refreshToken: string | undefined, userId: string): Promise<void> {
    if (refreshToken) {
      await this.tokens.revoke(refreshToken, userId);
    }
  }
}
