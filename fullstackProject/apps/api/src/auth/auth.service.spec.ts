import { UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { TokensService } from '../tokens/tokens.service';
import { User, toUserDto } from '../users/user.entity';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

/** rounds=4 — тестам не нужна продакшен-стоимость хэша */
const TEST_ROUNDS = 4;

describe('AuthService', () => {
  let service: AuthService;
  let user: User;
  let tokens: {
    issuePair: jest.Mock;
    consume: jest.Mock;
    revoke: jest.Mock;
  };

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
    } as unknown as UsersService;
    tokens = {
      issuePair: jest.fn(async () => ({
        accessToken: 'access-x',
        refreshToken: 'refresh-x',
        user: toUserDto(user),
      })),
      consume: jest.fn(),
      revoke: jest.fn(),
    };
    service = new AuthService(fakeUsers, tokens as unknown as TokensService);
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
});
