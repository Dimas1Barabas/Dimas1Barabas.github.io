import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { IsNull, LessThan, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { User } from '../users/user.entity';
import { BackupCode } from './backup-code.entity';
import { TrustedDevice } from './trusted-device.entity';
import { TwoFactorChallenge } from './two-factor-challenge.entity';
import {
  backupCodeHash,
  generateBackupCode,
  generateTotpSecret,
  otpauthUri,
  verifyTotp,
} from './totp';

/** билет второго шага живёт 5 минут */
export const CHALLENGE_TTL_MS = 5 * 60_000;
/** неверных кодов на билет — потом вход начинать заново */
export const MAX_CHALLENGE_ATTEMPTS = 5;
/** доверенное устройство — 30 дней, продлевается каждым входом */
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** backup-кодов при включении — десяток */
export const BACKUP_CODE_COUNT = 10;

const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

/** неверный код — единый ответ и профилю, и второму шагу логина */
const wrongCode = () =>
  new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    message: 'Неверный код',
    code: 'totpInvalid',
  });

/** витрина профиля: включена ли, ждёт ли подтверждения */
export class TwoFactorStatusDto {
  @ApiProperty({ description: '2FA включена — логин спрашивает код' })
  enabled!: boolean;

  @ApiProperty({ description: 'секрет сгенерирован, ждёт подтверждения кодом' })
  pending!: boolean;
}

/** ответ setup: секрет для QR и ручного ввода */
export class TwoFactorSetupDto {
  @ApiProperty({ example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' })
  secret!: string;

  @ApiProperty({
    example: 'otpauth://totp/CineBooking%3Aalice%40example.com?secret=…',
  })
  otpauthUri!: string;
}

/** строка витрины доверенных устройств */
export class TrustedDeviceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Браузер на работе' })
  name!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', description: 'последний вход без кода' })
  lastUsedAt!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

@Injectable()
export class TwoFactorService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(BackupCode)
    private readonly codes: Repository<BackupCode>,
    @InjectRepository(TrustedDevice)
    private readonly devices: Repository<TrustedDevice>,
    @InjectRepository(TwoFactorChallenge)
    private readonly challenges: Repository<TwoFactorChallenge>,
  ) {}

  /** статус для витрины профиля */
  async status(user: AuthUser): Promise<TwoFactorStatusDto> {
    const row = await this.users.findOneByOrFail({ id: user.id });
    // != null ловит и undefined (фейки с частичными строками)
    const enabled = row.totpEnabledAt != null;
    return { enabled, pending: !enabled && row.totpSecret != null };
  }

  /**
   * Настройка: новый секрет (перезаписывает незавершённый). Включённую
   * 2FA не трогаем — сначала отключите кодом, потом перенастраивайте.
   */
  async setup(user: AuthUser): Promise<TwoFactorSetupDto> {
    const row = await this.users.findOneByOrFail({ id: user.id });
    if (row.totpEnabledAt) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: '2FA уже включена — отключите, чтобы перенастроить',
        code: 'twoFactorAlreadyOn',
      });
    }
    const secret = generateTotpSecret();
    await this.users.update({ id: user.id }, { totpSecret: secret, totpEnabledAt: null });
    return { secret, otpauthUri: otpauthUri({ secretBase32: secret, email: row.email }) };
  }

  /**
   * Включение подтверждённым кодом: секрет уже у приложения (QR
   * отсканирован), правильный код из приложения — доказательство.
   * Backup-коды выдаются один раз — наружу, в БД только хэши.
   */
  async enable(user: AuthUser, rawCode: string): Promise<string[]> {
    const row = await this.users.findOneByOrFail({ id: user.id });
    if (!row.totpSecret) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Сначала запросите QR на странице профиля',
        code: 'twoFactorNotSetup',
      });
    }
    if (row.totpEnabledAt) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: '2FA уже включена',
        code: 'twoFactorAlreadyOn',
      });
    }
    if (!verifyTotp(row.totpSecret, rawCode.trim())) throw wrongCode();

    await this.users.update({ id: user.id }, { totpEnabledAt: new Date() });
    await this.codes.delete({ userId: user.id });
    const codes: string[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const raw = generateBackupCode();
      codes.push(raw);
      // хэш нормализованного кода — той же функцией, что и сверка
      await this.codes.save(
        this.codes.create({ userId: user.id, codeHash: backupCodeHash(raw) }),
      );
    }
    return codes;
  }

  /**
   * Отключение кодом приложения или backup-кодом (телефон утерян —
   * код из распечатки). Гасит всё: секрет, backup-коды и доверенные
   * устройства (они были пропуском мимо кода).
   */
  async disable(user: AuthUser, rawCode: string): Promise<void> {
    const row = await this.users.findOneByOrFail({ id: user.id });
    if (!row.totpEnabledAt) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: '2FA не включена',
        code: 'twoFactorOff',
      });
    }
    if (!(await this.verifyCodeOrBackup(row, rawCode))) throw wrongCode();
    await this.resetAllForUser(user.id);
  }

  /** recovery-сброс (сброс пароля по ссылке): без кода, доверять нечему */
  async resetAllForUser(userId: string): Promise<void> {
    await this.users.update(
      { id: userId },
      { totpSecret: null, totpEnabledAt: null },
    );
    await this.codes.delete({ userId });
    await this.devices.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  /** включена ли 2FA у пользователя (решение логина о втором шаге) */
  async isEnabled(userId: string): Promise<boolean> {
    const row = await this.users.findOneByOrFail({ id: userId });
    return row.totpEnabledAt != null;
  }

  /** код второго шага: приложение или backup-код (расход атомарен) */
  async verifyLogin(userId: string, rawCode: string): Promise<boolean> {
    const row = await this.users.findOneByOrFail({ id: userId });
    return this.verifyCodeOrBackup(row, rawCode);
  }

  /** новый билет второго шага; протухшие подчищаем лениво */
  async issueChallenge(userId: string): Promise<string> {
    await this.challenges.delete({ expiresAt: LessThan(new Date()) });
    const ticket = randomBytes(32).toString('base64url');
    await this.challenges.save(
      this.challenges.create({
        userId,
        ticketHash: sha256(ticket),
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      }),
    );
    return ticket;
  }

  /**
   * Билет + код → владелец. Неверный код списывает попытку; после
   * пяти билет гасится (брутфорс идёт заново через логин с паролем и
   * корзиной Привратника). Неверный/истёкший/мертвый билет — null.
   */
  async consumeChallenge(
    rawTicket: string,
    rawCode: string,
  ): Promise<string | null> {
    const row = await this.challenges.findOneBy({
      ticketHash: sha256(rawTicket),
    });
    if (!row || row.usedAt || row.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    if (await this.verifyLogin(row.userId, rawCode)) {
      await this.challenges.update(
        { id: row.id, usedAt: IsNull() },
        { usedAt: new Date() },
      );
      return row.userId;
    }
    const attempts = row.attempts + 1;
    const patch: Partial<TwoFactorChallenge> = { attempts };
    if (attempts >= MAX_CHALLENGE_ATTEMPTS) patch.usedAt = new Date();
    await this.challenges.update({ id: row.id }, patch);
    return null;
  }

  // ── доверенные устройства ─────────────────────────────────────────

  /** выдать токен устройства: raw — в cookie, в БД — хэш; id строки —
   *  для нечувствительной куки «это устройство» в витрине профиля */
  async issueTrustedDevice(
    userId: string,
    name: string,
  ): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString('base64url');
    const saved = await this.devices.save(
      this.devices.create({
        userId,
        tokenHash: sha256(token),
        name: name.trim().slice(0, 60) || 'Браузер',
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
      }),
    );
    return { token, id: saved.id };
  }

  /** живое ли устройство; вход продлевает окно на 30 дней (слайдинг) */
  async touchTrustedDevice(userId: string, rawToken: string): Promise<boolean> {
    const row = await this.devices.findOneBy({
      tokenHash: sha256(rawToken),
      userId,
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
      return false;
    }
    await this.devices.update(
      { id: row.id },
      { lastUsedAt: new Date(), expiresAt: new Date(Date.now() + DEVICE_TTL_MS) },
    );
    return true;
  }

  /** витрина профиля: живые устройства, свежие по использованию */
  async listDevices(userId: string): Promise<TrustedDeviceDto[]> {
    const rows = await this.devices.find({ where: { userId, revokedAt: IsNull() } });
    return rows
      .filter((d) => d.expiresAt.getTime() > Date.now())
      .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
      .map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
      }));
  }

  /** отзыв: только свой и только живой (иначе 404) */
  async revokeDevice(userId: string, id: string): Promise<void> {
    const res = await this.devices.update(
      { id, userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    if (!res.affected) {
      throw new NotFoundException({
        statusCode: 404,
        error: 'Not Found',
        message: 'Устройство не найдено',
        code: 'deviceNotFound',
      });
    }
  }

  /** код приложения или backup-код; backup расходуется на месте */
  private async verifyCodeOrBackup(row: User, rawCode: string): Promise<boolean> {
    const code = rawCode.trim();
    if (row.totpSecret && verifyTotp(row.totpSecret, code)) return true;
    // backup: атомарный расход — условный UPDATE по used_at IS NULL,
    // повторное предъявление того же кода affected 0 (гонка двух вкладок)
    const res = await this.codes.update(
      { userId: row.id, codeHash: backupCodeHash(code), usedAt: IsNull() },
      { usedAt: new Date() },
    );
    return (res.affected ?? 0) > 0;
  }
}
