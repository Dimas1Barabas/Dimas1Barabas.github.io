import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { DataSource, IsNull, LessThan, Repository } from 'typeorm';
import { enqueueOutbox } from '../outbox/outbox';
import { OutboxRelayClient } from '../outbox/outbox-relay.client';
import { SessionPair, TokensService } from '../tokens/tokens.service';
import { toUserDto, UserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { TwoFactorService } from '../twofactor/twofactor.service';
import { PasswordReset } from './password-reset.entity';

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответа логина */
export class LoginResult {
  @ApiProperty({ description: 'Bearer-JWT, живёт 2 часа' })
  accessToken!: string;

  @ApiProperty({ type: UserDto })
  user!: UserDto;
}

/** ответ логина при включённой 2FA: пары нет, ждём код второго шага */
export class TwoFactorRequired {
  @ApiProperty({ example: true })
  twoFactorRequired!: boolean;

  @ApiProperty({ description: 'билет второго шага, живёт 5 минут' })
  ticket!: string;
}

const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

/** срок жизни ссылки сброса — 30 минут */
const RESET_TTL_MS = 30 * 60_000;

/** база ссылки в «письме»; фронт стенда живёт на 18080 */
const resetLinkBase = (): string =>
  process.env.RESET_LINK_BASE ?? 'http://localhost:18080/#/reset-password';

/** исход логина: пара (без 2FA или доверенное устройство) | билет */
export type LoginOutcome = SessionPair | TwoFactorRequired;

/** результат второго шага: пара + опциональный токен доверия */
export interface SecondFactorResult {
  pair: SessionPair;
  device?: { token: string; id: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    @InjectRepository(PasswordReset)
    private readonly resets: Repository<PasswordReset>,
    private readonly dataSource: DataSource,
    // будильник Курьера: «письмо» закоммичено — доставка без poll-тика
    private readonly outboxRelay: OutboxRelayClient,
    private readonly twofactor: TwoFactorService,
  ) {}

  /**
   * Вход: сверяем bcrypt-хэш; при включённой 2FA — билет вместо пары.
   * Доверенное устройство (токен из httpOnly-cookie) пропускает второй
   * шаг: пароль уже доказал личность, устройство — что код вводили тут.
   */
  async login(
    input: { email: string; password: string },
    deviceToken?: string,
  ): Promise<LoginOutcome> {
    const user = await this.users.findByEmail(input.email);
    // одинаково отвечаем на «нет такого» и «не тот пароль» — не раскрываем, в чём дело
    if (
      !user ||
      !(await bcrypt.compare(input.password, user.passwordHash))
    ) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    if (user.totpEnabledAt != null) {
      if (
        deviceToken &&
        (await this.twofactor.touchTrustedDevice(user.id, deviceToken))
      ) {
        return this.tokens.issuePair(user);
      }
      return {
        twoFactorRequired: true,
        ticket: await this.twofactor.issueChallenge(user.id),
      };
    }

    return this.tokens.issuePair(user);
  }

  /**
   * Второй шаг: билет + код (приложение или backup). Успех гасит билет
   * и выдаёт пару; по галочке — ещё и токен доверенного устройства.
   */
  async loginSecondFactor(input: {
    ticket: string;
    code: string;
    trustDevice?: boolean;
    deviceName?: string;
  }): Promise<SecondFactorResult> {
    const userId = await this.twofactor.consumeChallenge(
      input.ticket,
      input.code,
    );
    if (!userId) {
      throw new UnauthorizedException('Код неверен или билет входа истёк');
    }
    const user = await this.users.findById(userId);
    const pair = await this.tokens.issuePair(user);
    const device: SecondFactorResult['device'] = input.trustDevice
      ? await this.twofactor.issueTrustedDevice(
          user.id,
          input.deviceName ?? 'Браузер',
        )
      : undefined;
    return { pair, device };
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
   * эндпоинт не оракул; «письмо» со ссылкой пишется в outbox событием
   * user.password.reset (доставит Курьер), его печатает
   * notification-service (в стенде — в лог и историю /notifications).
   */
  async forgotPassword(email: string): Promise<void> {
    // ленивая чистка протухших ссылок — без cron
    await this.resets.delete({ expiresAt: LessThan(new Date()) });

    const user = await this.users.findByEmail(email);
    if (!user) return;

    const token = randomBytes(32).toString('base64url');
    // ссылка и «письмо» о ней — одной транзакцией: краш между записью
    // ссылки и публикацией больше не теряет письмо (доставит Курьер),
    // а «письмо без ссылки» не бывает вовсе
    await this.dataSource.transaction(async (em) => {
      await em.save(
        PasswordReset,
        em.create(PasswordReset, {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
        }),
      );
      await enqueueOutbox(em, 'user.password.reset', {
        email: user.email,
        message: `${resetLinkBase()}?token=${token}`,
      });
    });
    // «письмо» закоммичено — будим Курьера
    this.outboxRelay.poke();
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
    // сброс по ссылке — recovery-канал: телефон могли потерять вместе с
    // паролем, 2FA и доверенные устройства отзываются (иначе юзер заперт)
    await this.twofactor.resetAllForUser(user.id);
    return this.tokens.issuePair(await this.users.setPassword(user, input.newPassword));
  }
}
