import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { FindOperator } from 'typeorm';
import { TokensService } from '../tokens/tokens.service';
import { User, toUserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { PasswordReset } from './password-reset.entity';

/** rounds=4 — тестам не нужна продакшен-стоимость хэша */
const TEST_ROUNDS = 4;

/** Map-фейк таблицы password_resets с семантикой условного UPDATE */
class FakeResetRepo {
  seq = 0;
  rows: PasswordReset[] = [];

  create(p: Partial<PasswordReset>): PasswordReset {
    return {
      id: `pr-${++this.seq}`,
      createdAt: new Date(),
      usedAt: null,
      ...p,
    } as PasswordReset;
  }

  async save(row: PasswordReset): Promise<PasswordReset> {
    this.rows.push(row);
    return row;
  }

  async findOneBy(where: { tokenHash?: string }): Promise<PasswordReset | null> {
    return this.rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
  }

  async update(
    where: Record<string, unknown>,
    set: Partial<PasswordReset>,
  ): Promise<{ affected: number }> {
    const matched = this.rows.filter((r) => this.matches(r, where));
    matched.forEach((r) => Object.assign(r, set));
    return { affected: matched.length };
  }

  async delete(where: Record<string, unknown>): Promise<{ affected: number }> {
    const matched = this.rows.filter((r) => this.matches(r, where));
    this.rows = this.rows.filter((r) => !matched.includes(r));
    return { affected: matched.length };
  }

  private matches(row: PasswordReset, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, cond]) => {
      const value = row[key as keyof PasswordReset];
      if (cond instanceof FindOperator) {
        if (cond.type === 'isNull') return value === null;
        if (cond.type === 'lessThan') {
          return (value as Date) < (cond.value as Date);
        }
        return false;
      }
      return value === cond;
    });
  }
}

describe('AuthService', () => {
  let service: AuthService;
  let user: User;
  let tokens: {
    issuePair: jest.Mock;
    consume: jest.Mock;
    revoke: jest.Mock;
    revokeAllForUser: jest.Mock;
  };
  let resets: FakeResetRepo;
  let rabbit: { publish: jest.Mock };
  let setPassword: jest.Mock;

  beforeAll(async () => {
    user = {
      id: randomUUID(),
      email: 'anna@example.com',
      name: 'Аня',
      role: 'user',
      passwordHash: await bcrypt.hash('secret123', TEST_ROUNDS),
      createdAt: new Date(),
    };
  });

  beforeEach(() => {
    const fakeUsers = {
      findByEmail: async (email: string) =>
        email === user.email ? user : null,
      findById: async (id: string) => (id === user.id ? user : null),
      setPassword: jest.fn(async (u: User, password: string) => {
        u.passwordHash = await bcrypt.hash(password, TEST_ROUNDS);
        return u;
      }),
    };
    setPassword = fakeUsers.setPassword;
    tokens = {
      issuePair: jest.fn(async () => ({
        accessToken: 'access-x',
        refreshToken: 'refresh-x',
        user: toUserDto(user),
      })),
      consume: jest.fn(),
      revoke: jest.fn(),
      revokeAllForUser: jest.fn(),
    };
    resets = new FakeResetRepo();
    rabbit = { publish: jest.fn() };
    service = new AuthService(
      fakeUsers as unknown as UsersService,
      tokens as unknown as TokensService,
      resets as never,
      rabbit as never,
    );
  });

  it('вход выдаёт пару токенов: access в тело, refresh — под cookie', async () => {
    const result = await service.login({
      email: user.email,
      password: 'secret123',
    });

    expect(tokens.issuePair).toHaveBeenCalledWith(user);
    expect(result).toMatchObject({
      accessToken: 'access-x',
      refreshToken: 'refresh-x',
      user: { email: user.email },
    });
  });

  it('неверный пароль → 401, пары не выдано', async () => {
    await expect(
      service.login({ email: user.email, password: 'wrong-pass' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(tokens.issuePair).not.toHaveBeenCalled();
  });

  it('неизвестный email → тот же текст ошибки, что у неверного пароля', async () => {
    let wrongPasswordMessage: string | undefined;
    try {
      await service.login({ email: user.email, password: 'wrong-pass' });
    } catch (err) {
      wrongPasswordMessage = (err as UnauthorizedException).message;
    }

    await expect(
      service.login({ email: 'ghost@example.com', password: 'whatever' }),
    ).rejects.toThrow(wrongPasswordMessage);
  });

  it('refresh: потребляет cookie-токен и выдаёт свежую пару юзера', async () => {
    tokens.consume.mockResolvedValue(user.id);

    const result = await service.refresh('cookie-refresh-token');

    expect(tokens.consume).toHaveBeenCalledWith('cookie-refresh-token');
    expect(tokens.issuePair).toHaveBeenCalledWith(user);
    expect(result.accessToken).toBe('access-x');
  });

  it('refresh без cookie → 401', async () => {
    await expect(service.refresh(undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(tokens.consume).not.toHaveBeenCalled();
  });

  it('logout: гасит сессию юзера', async () => {
    await service.logout('cookie-refresh-token', user.id);

    expect(tokens.revoke).toHaveBeenCalledWith('cookie-refresh-token', user.id);
  });

  it('logout без cookie: не падает и ничего не ревокает', async () => {
    await expect(service.logout(undefined, user.id)).resolves.toBeUndefined();
    expect(tokens.revoke).not.toHaveBeenCalled();
  });

  describe('forgotPassword', () => {
    it('существующий email: «письмо» со ссылкой в обмен, в БД — хэш токена', async () => {
      await service.forgotPassword(user.email);

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'user.password.reset',
        expect.objectContaining({ email: user.email }),
      );
      const [, , payload] = rabbit.publish.mock.calls[0] as [
        string,
        string,
        { email: string; message: string },
      ];
      expect(payload.message).toMatch(/\?token=/);

      const token = payload.message.split('token=')[1];
      expect(resets.rows).toHaveLength(1);
      expect(resets.rows[0].tokenHash).not.toBe(token); // только sha256
    });

    it('неизвестный email: тишина — ни публикации, ни строки', async () => {
      await expect(
        service.forgotPassword('ghost@example.com'),
      ).resolves.toBeUndefined();

      expect(rabbit.publish).not.toHaveBeenCalled();
      expect(resets.rows).toHaveLength(0);
    });
  });

  describe('resetPassword', () => {
    /** токен из «письма» последнего forgot */
    async function tokenFromEmail(): Promise<string> {
      await service.forgotPassword(user.email);
      const [, , payload] = rabbit.publish.mock.calls.at(-1) as [
        string,
        string,
        { message: string },
      ];
      return payload.message.split('token=')[1];
    }

    it('счастливый путь: пароль сменён, все сессии отозваны, выдана пара', async () => {
      const token = await tokenFromEmail();
      const oldHash = user.passwordHash;

      const result = await service.resetPassword({
        token,
        newPassword: 'new-secret-9',
      });

      expect(result.accessToken).toBe('access-x');
      expect(setPassword).toHaveBeenCalledWith(user, 'new-secret-9');
      expect(user.passwordHash).not.toBe(oldHash);
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith(user.id);
      expect(resets.rows[0].usedAt).not.toBeNull(); // ссылка одноразовая
    });

    it('мусорный токен → 400 тем же текстом, что и протухший', async () => {
      await expect(
        service.resetPassword({ token: 'нет-такой-ссылки-123456', newPassword: 'x'.repeat(8) }),
      ).rejects.toThrow('Ссылка недействительна или истекла');
    });

    it('повторное использование ссылки → 400', async () => {
      const token = await tokenFromEmail();
      await service.resetPassword({ token, newPassword: 'new-secret-9' });

      await expect(
        service.resetPassword({ token, newPassword: 'another-9' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('протухшая ссылка → 400', async () => {
      const token = await tokenFromEmail();
      resets.rows[0].expiresAt = new Date(Date.now() - 1000);

      await expect(
        service.resetPassword({ token, newPassword: 'new-secret-9' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
