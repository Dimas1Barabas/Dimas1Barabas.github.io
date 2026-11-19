import { User } from '../users/user.entity';
import type { AuthUser } from '../auth/auth-user';
import { BackupCode } from './backup-code.entity';
import { TrustedDevice } from './trusted-device.entity';
import { TwoFactorChallenge } from './two-factor-challenge.entity';
import { totp } from './totp';
import {
  MAX_CHALLENGE_ATTEMPTS,
  TwoFactorService,
} from './twofactor.service';

/**
 * TwoFactorService на in-memory фейках: логика настроек, второго шага,
 * backup-кодов и доверенных устройств — без HTTP (контракт маршрутов —
 * twofactor.int). Время не мокаем: TOTP сам себе часы, текущий код
 * читаем тем же генератором, что и прод.
 */

const USER: AuthUser = {
  id: 'user-2fa',
  email: 'anna@test.local',
  name: 'Анна',
  role: 'user',
};

function userRow(partial: Partial<User> = {}): User {
  return {
    id: USER.id,
    email: USER.email,
    name: USER.name,
    role: 'user',
    passwordHash: 'x',
    referralCode: 'ABCD1234',
    referredBy: null,
    referralRewardedAt: null,
    totpSecret: null,
    totpEnabledAt: null,
    createdAt: new Date(),
    ...partial,
  };
}

/** фейк users: create-подобного нет — только чтение и update по id */
class FakeUsersRepo {
  rows: User[] = [userRow()];
  async findOneByOrFail(where: { id: string }): Promise<User> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new Error('user not found');
    return found;
  }
  async update(criteria: { id: string }, patch: Partial<User>): Promise<void> {
    const found = this.rows.find((r) => r.id === criteria.id);
    if (found) Object.assign(found, patch);
  }
}

/** фейк backup-кодов: расход повторяет условный UPDATE used_at IS NULL */
class FakeCodesRepo {
  rows: BackupCode[] = [];
  seq = 0;
  create(p: Partial<BackupCode>): BackupCode {
    return {
      id: `code-${++this.seq}`,
      userId: '',
      codeHash: '',
      createdAt: new Date(),
      usedAt: null,
      ...p,
    } as BackupCode;
  }
  async save(row: BackupCode): Promise<BackupCode> {
    this.rows.push(row);
    return row;
  }
  async delete(where: { userId: string }): Promise<void> {
    this.rows = this.rows.filter((r) => r.userId !== where.userId);
  }
  async update(
    criteria: { userId: string; codeHash: string },
    patch: { usedAt: Date },
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (const r of this.rows) {
      if (
        r.userId === criteria.userId &&
        r.codeHash === criteria.codeHash &&
        r.usedAt === null
      ) {
        r.usedAt = patch.usedAt;
        affected++;
      }
    }
    return { affected };
  }
}

class FakeDevicesRepo {
  rows: TrustedDevice[] = [];
  seq = 0;
  create(p: Partial<TrustedDevice>): TrustedDevice {
    return {
      id: `dev-${++this.seq}`,
      userId: '',
      tokenHash: '',
      name: '',
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: new Date(),
      revokedAt: null,
      ...p,
    } as TrustedDevice;
  }
  async save(row: TrustedDevice): Promise<TrustedDevice> {
    this.rows.push(row);
    return row;
  }
  async find(): Promise<TrustedDevice[]> {
    return this.rows.filter((r) => r.revokedAt === null);
  }
  async findOneBy(where: { tokenHash: string; userId: string }) {
    return (
      this.rows.find(
        (r) => r.tokenHash === where.tokenHash && r.userId === where.userId,
      ) ?? null
    );
  }
  async update(
    criteria: { id?: string; userId?: string; revokedAt?: unknown },
    patch: Partial<TrustedDevice>,
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (const r of this.rows) {
      const byId = criteria.id === undefined || r.id === criteria.id;
      const byUser = criteria.userId === undefined || r.userId === criteria.userId;
      // IsNull() из typeorm в критерии — объект, не null: любое
      // присутствие поля значит «строка должна быть с NULL в колонке»
      const byRevoked =
        criteria.revokedAt === undefined || r.revokedAt === null;
      if (byId && byUser && byRevoked) {
        Object.assign(r, patch);
        affected++;
      }
    }
    return { affected };
  }
}

class FakeChallengesRepo {
  rows: TwoFactorChallenge[] = [];
  seq = 0;
  create(p: Partial<TwoFactorChallenge>): TwoFactorChallenge {
    return {
      id: `chal-${++this.seq}`,
      userId: '',
      ticketHash: '',
      attempts: 0,
      expiresAt: new Date(),
      usedAt: null,
      createdAt: new Date(),
      ...p,
    } as TwoFactorChallenge;
  }
  async save(row: TwoFactorChallenge): Promise<TwoFactorChallenge> {
    this.rows.push(row);
    return row;
  }
  async delete(): Promise<void> {
    this.rows = [];
  }
  async findOneBy(where: { ticketHash: string }) {
    return this.rows.find((r) => r.ticketHash === where.ticketHash) ?? null;
  }
  async update(
    criteria: { id: string },
    patch: Partial<TwoFactorChallenge>,
  ): Promise<void> {
    const found = this.rows.find((r) => r.id === criteria.id);
    if (found) Object.assign(found, patch);
  }
}

describe('TwoFactorService (юнит, фейк-репозитории)', () => {
  let users: FakeUsersRepo;
  let codes: FakeCodesRepo;
  let devices: FakeDevicesRepo;
  let challenges: FakeChallengesRepo;
  let service: TwoFactorService;

  beforeEach(() => {
    users = new FakeUsersRepo();
    codes = new FakeCodesRepo();
    devices = new FakeDevicesRepo();
    challenges = new FakeChallengesRepo();
    service = new TwoFactorService(
      users as never,
      codes as never,
      devices as never,
      challenges as never,
    );
  });

  /** свежая включённая 2FA: { секрет приложения, выданные backup-коды } */
  async function enableFresh(): Promise<{ secret: string; backup: string[] }> {
    const { secret } = await service.setup(USER);
    const backup = await service.enable(USER, totp(secret));
    return { secret, backup };
  }

  describe('setup', () => {
    it('генерирует секрет и otpauth-ссылку с email владельца', async () => {
      const dto = await service.setup(USER);
      expect(dto.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(dto.otpauthUri).toContain(
        'otpauth://totp/CineBooking%3Aanna%40test.local',
      );
      expect(dto.otpauthUri).toContain(`secret=${dto.secret}`);
    });

    it('повторный setup до включения перегенерирует секрет (pending)', async () => {
      const first = await service.setup(USER);
      const second = await service.setup(USER);
      expect(second.secret).not.toBe(first.secret);
      expect(await service.status(USER)).toEqual({ enabled: false, pending: true });
    });

    it('включённую 2FA setup не трогает — 409', async () => {
      await enableFresh();
      await expect(service.setup(USER)).rejects.toMatchObject({
        status: 409,
        response: { code: 'twoFactorAlreadyOn' },
      });
    });
  });

  describe('enable', () => {
    it('без setup — 400 twoFactorNotSetup', async () => {
      await expect(service.enable(USER, '123456')).rejects.toMatchObject({
        status: 400,
      });
    });

    it('неверный код — 401 totpInvalid, 2FA не включена', async () => {
      await service.setup(USER);
      await expect(service.enable(USER, '000000')).rejects.toMatchObject({
        status: 401,
        response: { code: 'totpInvalid' },
      });
      expect((await service.status(USER)).enabled).toBe(false);
    });

    it('верный код включает: 10 разных backup-кодов формата XXXX-XXXX', async () => {
      const { backup } = await enableFresh();
      expect(backup).toHaveLength(10);
      for (const c of backup) {
        expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      }
      expect(new Set(backup).size).toBe(10);
      expect(await service.status(USER)).toEqual({ enabled: true, pending: false });
    });
  });

  describe('disable', () => {
    it('кодом приложения выключает и гасит backup-коды с устройствами', async () => {
      const { secret } = await enableFresh();
      const token = await service.issueTrustedDevice(USER.id, 'Ноутбук');
      expect(await service.listDevices(USER.id)).toHaveLength(1);

      await service.disable(USER, totp(secret));

      expect(await service.status(USER)).toEqual({ enabled: false, pending: false });
      expect(codes.rows).toHaveLength(0);
      expect(await service.listDevices(USER.id)).toHaveLength(0);
      expect(await service.touchTrustedDevice(USER.id, token)).toBe(false);
    });

    it('backup-кодом тоже можно (телефон утерян), регистр прощается', async () => {
      const { backup } = await enableFresh();
      await expect(
        service.disable(USER, backup[3].toLowerCase()),
      ).resolves.toBeUndefined();
      expect((await service.status(USER)).enabled).toBe(false);
    });

    it('неверный код — 401, 2FA остаётся', async () => {
      await enableFresh();
      await expect(service.disable(USER, '111111')).rejects.toMatchObject({
        status: 401,
      });
      expect((await service.status(USER)).enabled).toBe(true);
    });

    it('без включённой 2FA — 409', async () => {
      await expect(service.disable(USER, '123456')).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  describe('verifyLogin: код приложения и backup', () => {
    it('текущий код приложения подходит', async () => {
      const { secret } = await enableFresh();
      expect(await service.verifyLogin(USER.id, totp(secret))).toBe(true);
    });

    it('backup-код одноразов: второй раз — false', async () => {
      const { backup } = await enableFresh();
      expect(await service.verifyLogin(USER.id, backup[7])).toBe(true);
      expect(await service.verifyLogin(USER.id, backup[7])).toBe(false);
    });

    it('использованный backup не оживляет чужой код', async () => {
      const { backup } = await enableFresh();
      await service.verifyLogin(USER.id, backup[0]);
      expect(await service.verifyLogin(USER.id, backup[0])).toBe(false);
      // остальные коды живы
      expect(await service.verifyLogin(USER.id, backup[1])).toBe(true);
    });
  });

  describe('билет второго шага', () => {
    it('верный код гасит билет и отдаёт владельца; повторно билет мёртв', async () => {
      const { secret } = await enableFresh();
      const ticket = await service.issueChallenge(USER.id);
      expect(await service.consumeChallenge(ticket, totp(secret))).toBe(USER.id);
      expect(await service.consumeChallenge(ticket, totp(secret))).toBeNull();
    });

    it('пять неверных кодов убивают билет — даже верный потом не проходит', async () => {
      const { secret } = await enableFresh();
      const ticket = await service.issueChallenge(USER.id);
      for (let i = 0; i < MAX_CHALLENGE_ATTEMPTS; i++) {
        expect(await service.consumeChallenge(ticket, '999999')).toBeNull();
      }
      expect(await service.consumeChallenge(ticket, totp(secret))).toBeNull();
    });

    it('неизвестный билет — null', async () => {
      await enableFresh();
      expect(await service.consumeChallenge('nope', '123456')).toBeNull();
    });
  });

  describe('доверенные устройства', () => {
    it('выдача обрезает имя; touch продлевает окно и метку использования', async () => {
      const token = await service.issueTrustedDevice(USER.id, '  Браузер на работе  ');
      const first = (await service.listDevices(USER.id))[0];
      expect(first.name).toBe('Браузер на работе');

      expect(await service.touchTrustedDevice(USER.id, token)).toBe(true);

      const second = (await service.listDevices(USER.id))[0];
      expect(new Date(second.lastUsedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(first.lastUsedAt).getTime(),
      );
      // слайдинг: окно не короче исходного (та же миллисекунда — равны)
      expect(new Date(second.expiresAt).getTime()).toBeGreaterThanOrEqual(
        new Date(first.expiresAt).getTime(),
      );
    });

    it('чужой токен не живой', async () => {
      await service.issueTrustedDevice(USER.id, 'Мой');
      expect(await service.touchTrustedDevice(USER.id, 'alien')).toBe(false);
    });

    it('отзыв: вход снова спросит код; повторный отзыв — 404', async () => {
      const token = await service.issueTrustedDevice(USER.id, 'Телефон');
      const [device] = await service.listDevices(USER.id);
      await service.revokeDevice(USER.id, device.id);
      expect(await service.touchTrustedDevice(USER.id, token)).toBe(false);
      expect(await service.listDevices(USER.id)).toHaveLength(0);
      await expect(service.revokeDevice(USER.id, device.id)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('resetAllForUser (recovery-сброс): секрет, коды и устройства гасятся', async () => {
      const { secret } = await enableFresh();
      await service.issueTrustedDevice(USER.id, 'Ноутбук');
      await service.resetAllForUser(USER.id);
      expect(await service.status(USER)).toEqual({ enabled: false, pending: false });
      expect(await service.verifyLogin(USER.id, totp(secret))).toBe(false);
      expect(await service.listDevices(USER.id)).toHaveLength(0);
    });
  });
});
