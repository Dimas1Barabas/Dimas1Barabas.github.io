import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { IsNull, LessThan, Repository } from 'typeorm';
import { SessionPair, TokensService } from '../tokens/tokens.service';
import { toUserDto, UserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { PasswordReset } from './password-reset.entity';

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответа логина */
export class LoginResult {
  @ApiProperty({ description: 'Bearer-JWT, живёт 2 часа' })
  accessToken!: string;

  @ApiProperty({ type: UserDto })
  user!: UserDto;
}

const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

/** срок жизни ссылки сброса — 30 минут */
const RESET_TTL_MS = 30 * 60_000;

/** база ссылки в «письме»; фронт стенда живёт на 18080 */
const resetLinkBase = (): string =>
  process.env.RESET_LINK_BASE ?? 'http://localhost:18080/#/reset-password';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    @InjectRepository(PasswordReset)
    private readonly resets: Repository<PasswordReset>,
    private readonly rabbit: AmqpConnection,
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

  /**
   * Запрос сброса пароля. Ответ НЕ зависит от существования email —
   * эндпоинт не оракул; «письмо» со ссылкой публикуется событием
   * user.password.reset, его печатает notification-service (в стенде —
   * в лог и историю /notifications).
   */
  async forgotPassword(email: string): Promise<void> {
    // ленивая чистка протухших ссылок — без cron
    await this.resets.delete({ expiresAt: LessThan(new Date()) });

    const user = await this.users.findByEmail(email);
    if (!user) return;

    const token = randomBytes(32).toString('base64url');
    await this.resets.save(
      this.resets.create({
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      }),
    );

    await this.rabbit.publish('cinema', 'user.password.reset', {
      email: user.email,
      message: `${resetLinkBase()}?token=${token}`,
    });
  }

  /**
   * Сброс по ссылке: токен одноразовый (условный UPDATE по used_at IS NULL
   * закрывает гонку двух кликов), смена пароля = выход отовсюду, но это
   * устройство сразу получает свежую пару.
   */
  async resetPassword(input: {
    token: string;
    newPassword: string;
  }): Promise<SessionPair> {
    const bad = () => new BadRequestException('Ссылка недействительна или истекла');
    const row = await this.resets.findOneBy({
      tokenHash: sha256(input.token),
    });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
      throw bad();
    }
    const res = await this.resets.update(
      { id: row.id, usedAt: IsNull() },
      { usedAt: new Date() },
    );
    if (!res.affected) throw bad();

    const user = await this.users.findById(row.userId);
    await this.tokens.revokeAllForUser(user.id);
    return this.tokens.issuePair(await this.users.setPassword(user, input.newPassword));
  }
}
