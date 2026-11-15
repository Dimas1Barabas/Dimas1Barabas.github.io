import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { User } from '../users/user.entity';
import { REFERRAL_EARNED_SQL } from './referrals.logic';
import { ReferralsService } from './referrals.service';

function makeUser(patch: Partial<User> = {}): User {
  return {
    id: randomUUID(),
    email: 'anna@example.com',
    name: 'Аня',
    role: 'user',
    passwordHash: 'x',
    referralCode: 'AB2CD3EF',
    referredBy: null,
    referralRewardedAt: null,
    createdAt: new Date(),
    ...patch,
  } as User;
}

/** Map-фейк репозитория users: find по referredBy, save-обновления */
class FakeUserRepo {
  rows: User[] = [];
  saved: User[] = [];

  async find(options: { where: { referredBy?: string } }): Promise<User[]> {
    return this.rows
      .filter((r) => r.referredBy === options.where.referredBy)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findOneBy(where: { id?: string }): Promise<User | null> {
    return this.rows.find((r) => r.id === where.id) ?? null;
  }

  async findOneByOrFail(where: { id?: string }): Promise<User> {
    const found = await this.findOneBy(where);
    if (!found) throw new Error('not found');
    return found;
  }

  async save(user: User): Promise<User> {
    this.saved.push(user);
    return user;
  }
}

/** фейк ledger-репозитория: только manager.query для REFERRAL_EARNED_SQL */
function fakeLedgerRepo(earned: number) {
  return {
    manager: {
      query: jest.fn(
        async (sql: string, params: unknown[]): Promise<{ earned: string }[]> => {
          expect(sql).toBe(REFERRAL_EARNED_SQL);
          expect(params).toHaveLength(1);
          return [{ earned: String(earned) }];
        },
      ),
    },
  };
}

function authUserOf(user: User): AuthUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

describe('ReferralsService', () => {
  it('отдаёт код, статистику и маскированные email приглашённых', async () => {
    const host = makeUser();
    const paidFriend = makeUser({
      email: 'bob@example.com',
      name: 'Боб',
      referredBy: host.id,
      referralCode: 'PAAAAAAA',
      referralRewardedAt: new Date(),
    });
    const lazyFriend = makeUser({
      email: 'carol@example.com',
      name: 'Кэрол',
      referredBy: host.id,
      referralCode: 'PBBBBBBB',
    });
    const stranger = makeUser({ email: 'stranger@example.com' });
    const users = new FakeUserRepo();
    users.rows = [host, paidFriend, lazyFriend, stranger];

    const service = new ReferralsService(
      users as unknown as Repository<User>,
      fakeLedgerRepo(300) as unknown as Repository<BonusTransaction>,
    );

    const dto = await service.my(authUserOf(host));

    expect(dto.code).toBe('AB2CD3EF');
    expect(dto.bonusInviter).toBe(300);
    expect(dto.bonusFriend).toBe(100);
    expect(dto.totals).toEqual({ invited: 2, paid: 1, earned: 300 });
    expect(dto.invited).toHaveLength(2);
    expect(dto.invited[0]).toMatchObject({
      name: 'Боб',
      email: 'b***@example.com',
      paid: true,
    });
    expect(dto.invited[1]).toMatchObject({
      name: 'Кэрол',
      email: 'c***@example.com',
      paid: false,
    });
    // чужие (без referred_by) в список не попадают
    expect(dto.invited.map((i) => i.email)).not.toContain('s***@example.com');
  });

  it("юзеру до рефералки код догенерируется при первом запросе и сохраняется", async () => {
    const legacy = makeUser({ referralCode: null });
    const users = new FakeUserRepo();
    users.rows = [legacy];

    const service = new ReferralsService(
      users as unknown as Repository<User>,
      fakeLedgerRepo(0) as unknown as Repository<BonusTransaction>,
    );

    const dto = await service.my(authUserOf(legacy));

    expect(dto.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(users.saved).toHaveLength(1);
    expect(users.saved[0].referralCode).toBe(dto.code);
    expect(dto.totals).toEqual({ invited: 0, paid: 0, earned: 0 });
    expect(dto.invited).toEqual([]);
  });

  it('существующий код не перегенерируется', async () => {
    const host = makeUser({ referralCode: 'KEEPC0DE' });
    const users = new FakeUserRepo();
    users.rows = [host];

    const service = new ReferralsService(
      users as unknown as Repository<User>,
      fakeLedgerRepo(0) as unknown as Repository<BonusTransaction>,
    );

    expect((await service.my(authUserOf(host))).code).toBe('KEEPC0DE');
    expect(users.saved).toHaveLength(0);
  });
});
