/**
 * Демо-движок: аккаунт: симуляция auth-модуля — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';

describe('demoEngine: аккаунт: симуляция auth-модуля', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('аккаунт: симуляция auth-модуля', () => {
    it('вход с любыми данными до регистрации; сессия — «свежая пара»', () => {
      const result = demoEngine.login('Anna@Example.com', 'secret123');

      expect(result.accessToken).toBe('demo-session');
      expect(result.user).toMatchObject({
        email: 'anna@example.com',
        name: 'Гость',
        role: 'user',
      });
    });

    it('после входа неверный пароль — 401 тем же текстом, что у API', () => {
      demoEngine.login('anna@example.com', 'secret123');

      expect(() => demoEngine.login('anna@example.com', 'wrong')).toThrowError(
        expect.objectContaining({ status: 401 }),
      );
      try {
        demoEngine.login('anna@example.com', 'wrong');
      } catch (err) {
        expect((err as ApiError).body).toContain('Неверный email или пароль');
      }
    });

    it('регистрация: имя сохраняется, занятый email — 409 emailTaken', () => {
      const user = demoEngine.register({
        email: 'bob@example.com',
        password: 'secret123',
        name: 'Боб',
      });
      expect(user).toMatchObject({ email: 'bob@example.com', name: 'Боб' });

      // свой email занят...
      expect(() =>
        demoEngine.register({ email: 'BOB@example.com', password: 'x'.repeat(8), name: 'Дубль' }),
      ).toThrowError(expect.objectContaining({ status: 409 }));
      // ...и демо-админ тоже
      expect(() =>
        demoEngine.register({ email: 'admin@cine.local', password: 'x'.repeat(8), name: 'Админ' }),
      ).toThrowError(expect.objectContaining({ status: 409 }));
    });

    it('профиль: имя/email меняются, ответ — новая пара с копией юзера', () => {
      demoEngine.login('anna@example.com', 'secret123');

      const result = demoEngine.updateProfile({ name: 'Анна Новая', email: 'anna@new.com' });

      expect(result.user).toMatchObject({ name: 'Анна Новая', email: 'anna@new.com' });
      expect(result.user).not.toBe(demoEngine.updateProfile({}).user); // копии, не одна ссылка

      // email демо-админа занят — 409 (паритет PATCH /users/me)
      expect(() => demoEngine.updateProfile({ email: 'admin@cine.local' })).toThrowError(
        expect.objectContaining({ status: 409 }),
      );
    });

    it('смена пароля: неверный текущий — 403, верный — принимает новый', () => {
      demoEngine.login('anna@example.com', 'secret123');

      expect(() =>
        demoEngine.changePassword('wrong-old', 'new-secret-9'),
      ).toThrowError(expect.objectContaining({ status: 403 }));

      demoEngine.changePassword('secret123', 'new-secret-9');
      // вход работает только с новым паролем
      expect(() => demoEngine.login('anna@example.com', 'secret123')).toThrow();
      expect(demoEngine.login('anna@example.com', 'new-secret-9').user.email).toBe(
        'anna@example.com',
      );
    });

    it('восстановление: forgot отдаёт токен, reset меняет пароль и логинит', () => {
      demoEngine.login('anna@example.com', 'secret123');
      const token = demoEngine.forgotPassword('anna@example.com');
      expect(token).toBe('demo-reset-token');

      const result = demoEngine.resetPassword(token, 'reset-new-9');
      expect(result.user.email).toBe('anna@example.com');

      expect(() => demoEngine.login('anna@example.com', 'secret123')).toThrow();
      expect(demoEngine.login('anna@example.com', 'reset-new-9').accessToken).toBe(
        'demo-session',
      );
    });

    it('мусорный токен сброса — 400 тем же текстом, что у API', () => {
      demoEngine.login('anna@example.com', 'secret123');
      try {
        demoEngine.resetPassword('нет-такой-ссылки-123456', 'whatever-9');
        throw new Error('ожидали 400');
      } catch (err) {
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).body).toContain('Ссылка недействительна');
      }
    });

    it('logout гасит сессию: смена пароля после — 401', () => {
      demoEngine.login('anna@example.com', 'secret123');
      demoEngine.logout();

      expect(() => demoEngine.changePassword('secret123', 'next-9')).toThrowError(
        expect.objectContaining({ status: 401 }),
      );
    });
  });

});
