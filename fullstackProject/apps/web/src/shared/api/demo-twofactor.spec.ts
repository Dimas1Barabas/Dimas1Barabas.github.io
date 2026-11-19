/**
 * Демо-движок: 2FA — зеркало TwoFactorService API и второго шага логина:
 * те же коды ошибок и семантика (setup/enable/disable, backup одноразово,
 * билет с лимитом попыток, доверенное устройство, recovery при сбросе).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { totp } from '@/shared/lib/totp';

describe('demoEngine: 2FA — зеркало API', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
    demoEngine.reset();
    demoEngine.register({
      email: 'anna@example.com',
      password: 'secret123',
      name: 'Анна',
    });
    demoEngine.login('anna@example.com', 'secret123');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** включённая 2FA: setup → enable текущим кодом (движок знает секрет) */
  function enable(): { secret: string; backup: string[] } {
    const setup = demoEngine.twoFactorSetup();
    const backup = demoEngine.twoFactorEnable(totp(setup.secret)).backupCodes;
    return { secret: setup.secret, backup };
  }

  it('статус до настройки: выключена, ничего не ждёт', () => {
    expect(demoEngine.twoFactorStatus()).toEqual({ enabled: false, pending: false });
  });

  it('setup: секрет и otpauth с email владельца, статус — pending', () => {
    const setup = demoEngine.twoFactorSetup();
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUri).toContain('otpauth://totp/CineBooking%3Aanna%40example.com');
    expect(demoEngine.twoFactorStatus()).toEqual({
      enabled: false,
      pending: true,
      demoCurrentCode: totp(setup.secret),
    });
  });

  it('enable неверным кодом — 401 totpInvalid, верным — 10 кодов и статус on', () => {
    const setup = demoEngine.twoFactorSetup();
    expect(() => demoEngine.twoFactorEnable('000000')).toThrowError(
      expect.objectContaining({ status: 401 }),
    );

    const { backupCodes } = demoEngine.twoFactorEnable(totp(setup.secret));
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);
    expect(demoEngine.twoFactorStatus().enabled).toBe(true);
  });

  it('логин при включённой 2FA: билет вместо пары', () => {
    enable();
    demoEngine.logout();

    const outcome = demoEngine.login('anna@example.com', 'secret123');
    expect(outcome).toEqual({
      twoFactorRequired: true,
      ticket: 'demo-2fa-ticket',
    });
  });

  it('второй шаг: код приложения проходит, билет одноразовый', () => {
    const { secret } = enable();
    demoEngine.logout();
    const { ticket } = demoEngine.login('anna@example.com', 'secret123') as {
      twoFactorRequired: true;
      ticket: string;
    };

    const result = demoEngine.loginSecondFactor({ ticket, code: totp(secret) });
    expect(result.accessToken).toBe('demo-session');

    expect(() =>
      demoEngine.loginSecondFactor({ ticket, code: totp(secret) }),
    ).toThrowError(expect.objectContaining({ status: 401 }));
  });

  it('backup-код вместо кода приложения — и одноразово', () => {
    const { backup } = enable();
    demoEngine.logout();
    const { ticket } = demoEngine.login('anna@example.com', 'secret123') as {
      twoFactorRequired: true;
      ticket: string;
    };

    const ok = demoEngine.loginSecondFactor({
      ticket,
      code: backup[4].toLowerCase(),
    });
    expect(ok.accessToken).toBe('demo-session');

    // тот же код второй раз — не проходит (новый билет)
    const { ticket: t2 } = demoEngine.login('anna@example.com', 'secret123') as {
      twoFactorRequired: true;
      ticket: string;
    };
    expect(() =>
      demoEngine.loginSecondFactor({ ticket: t2, code: backup[4] }),
    ).toThrowError(expect.objectContaining({ status: 401 }));
  });

  it('пять неверных кодов убивают билет до верного', () => {
    const { secret } = enable();
    demoEngine.logout();
    const { ticket } = demoEngine.login('anna@example.com', 'secret123') as {
      twoFactorRequired: true;
      ticket: string;
    };

    for (let i = 0; i < 5; i++) {
      expect(() =>
        demoEngine.loginSecondFactor({ ticket, code: '999999' }),
      ).toThrowError(expect.objectContaining({ status: 401 }));
    }
    expect(() =>
      demoEngine.loginSecondFactor({ ticket, code: totp(secret) }),
    ).toThrowError(expect.objectContaining({ status: 401 }));
  });

  it('доверенное устройство: вход без второго шага и отзыв из профиля', () => {
    const { secret } = enable();
    demoEngine.logout();
    const { ticket } = demoEngine.login('anna@example.com', 'secret123') as {
      twoFactorRequired: true;
      ticket: string;
    };

    demoEngine.loginSecondFactor({
      ticket,
      code: totp(secret),
      trustDevice: true,
      deviceName: '  Рабочий ноутбук  ',
    });
    demoEngine.logout();

    // доверенное устройство: сразу пара
    const second = demoEngine.login('anna@example.com', 'secret123');
    expect('twoFactorRequired' in second).toBe(false);

    const devices = demoEngine.twoFactorDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toBe('Рабочий ноутбук');

    demoEngine.revokeTwoFactorDevice(devices[0].id);
    expect(demoEngine.twoFactorDevices()).toHaveLength(0);
    expect(() =>
      demoEngine.revokeTwoFactorDevice(devices[0].id),
    ).toThrowError(expect.objectContaining({ status: 404 }));

    const third = demoEngine.login('anna@example.com', 'secret123');
    expect(third).toMatchObject({ twoFactorRequired: true });
  });

  it('disable кодом приложения гасит всё; последующий вход без второго шага', () => {
    const { secret } = enable();
    demoEngine.twoFactorDisable(totp(secret));

    expect(demoEngine.twoFactorStatus()).toEqual({ enabled: false, pending: false });
    demoEngine.logout();
    const outcome = demoEngine.login('anna@example.com', 'secret123');
    expect('twoFactorRequired' in outcome).toBe(false);
  });

  it('сброс пароля по ссылке — recovery: 2FA и доверие гасятся', () => {
    enable();
    demoEngine.forgotPassword('anna@example.com');

    demoEngine.resetPassword('demo-reset-token', 'new-secret-9');

    expect(demoEngine.twoFactorStatus()).toEqual({ enabled: false, pending: false });
    demoEngine.logout();
    const outcome = demoEngine.login('anna@example.com', 'new-secret-9');
    expect('twoFactorRequired' in outcome).toBe(false);
  });

  it('подсказка кода живёт только при включённой 2FA', () => {
    expect(demoEngine.demoTotpHint()).toBeNull();
    const { secret } = enable();
    expect(demoEngine.demoTotpHint()).toBe(totp(secret));
  });

  it('без сессии настройки — 401, как гвард API', () => {
    demoEngine.logout();
    expect(() => demoEngine.twoFactorStatus()).toThrowError(
      expect.objectContaining({ status: 401 }),
    );
    try {
      demoEngine.twoFactorSetup();
    } catch (err) {
      expect((err as ApiError).status).toBe(401);
    }
  });
});
