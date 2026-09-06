import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { User } from '../users/user.entity';
import { AuthService } from './auth.service';

/** rounds=4 — тестам не нужна продакшен-стоимость хэша */
const TEST_ROUNDS = 4;

describe('AuthService', () => {
  const TEST_SECRET = 'unit-test-secret';
  let jwt: JwtService;
  let service: AuthService;
  let user: User;

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
    jwt = new JwtService({ secret: TEST_SECRET });
    const fakeUsers = {
      findByEmail: async (email: string) =>
        email === user.email ? user : null,
    } as unknown as UsersService;
    service = new AuthService(fakeUsers, jwt);
  });

  it('выдаёт JWT с клеймами пользователя', async () => {
    const result = await service.login({
      email: user.email,
      password: 'secret123',
    });

    expect(result.user.email).toBe(user.email);
    const payload = await jwt.verifyAsync<{
      sub: string;
      email: string;
      name: string;
      role: string;
    }>(result.accessToken);
    expect(payload.sub).toBe(user.id);
    expect(payload.email).toBe(user.email);
    expect(payload.name).toBe(user.name);
    expect(payload.role).toBe('user');
  });

  it('неверный пароль → 401', async () => {
    await expect(
      service.login({ email: user.email, password: 'wrong-pass' }),
    ).rejects.toThrow(UnauthorizedException);
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
});
