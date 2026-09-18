import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import { FindOperator } from 'typeorm';
import { User } from '../users/user.entity';
import { RefreshToken } from './refresh-token.entity';
import { REFRESH_TTL_MS, TokensService } from './tokens.service';

const TEST_SECRET = 'unit-tokens-secret';
const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

/**
 * Map-фейк репозитория. Ключевое — честная семантика условного UPDATE:
 * критерий с IsNull()/LessThan() фильтрует строки, affected = числу
 * совпавших — без этого не покрыть ни ротацию, ни reuse-detection.
 */
class FakeTokenRepo {
  seq = 0;
  rows: RefreshToken[] = [];

  create(p: Partial<RefreshToken>): RefreshToken {
    return {
      id: `rt-${++this.seq}`,
      createdAt: new Date(),
      revokedAt: null,
      ...p,
    } as RefreshToken;
  }

  async save(row: RefreshToken): Promise<RefreshToken> {
    this.rows.push(row);
    return row;
  }

  async findOneBy(where: { tokenHash?: string }): Promise<RefreshToken | null> {
    return this.rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
  }

  async update(
    where: Record<string, unknown>,
    set: Partial<RefreshToken>,
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

  private matches(row: RefreshToken, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, cond]) => {
      const value = row[key as keyof RefreshToken];
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

describe('TokensService', () => {
  let service: TokensService;
  let repo: FakeTokenRepo;
  let jwt: JwtService;
  let user: User;

  beforeAll(async () => {
    user = {
      id: randomUUID(),
      email: 'anna@example.com',
      name: 'Аня',
      role: 'user',
      passwordHash: 'не-важен-здесь',
      createdAt: new Date(),
    };
  });

  beforeEach(() => {
    repo = new FakeTokenRepo();
    jwt = new JwtService({ secret: TEST_SECRET });
    service = new TokensService(repo as never, jwt);
  });

  it('issuePair: access несёт 4 клейма, в БД — sha256-хэш refresh, не сам токен', async () => {
    const pair = await service.issuePair(user);

    const payload = await jwt.verifyAsync<{
      sub: string;
      email: string;
      name: string;
      role: string;
    }>(pair.accessToken);
    expect(payload).toMatchObject({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: 'user',
    });

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].tokenHash).toBe(sha256(pair.refreshToken));
    expect(repo.rows[0].tokenHash).not.toBe(pair.refreshToken);
  });

  it('issuePair: refresh-сессия живёт 30 дней', async () => {
    const before = Date.now();
    const pair = await service.issuePair(user);

    const ttl = repo.rows[0].expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(REFRESH_TTL_MS - 5000);
    expect(ttl).toBeLessThanOrEqual(REFRESH_TTL_MS + 5000);
  });

  it('consume: живой токен → userId, строка помечена revoked_at (ротация)', async () => {
    const pair = await service.issuePair(user);

    const userId = await service.consume(pair.refreshToken);

    expect(userId).toBe(user.id);
    expect(repo.rows[0].revokedAt).not.toBeNull();
  });

  it('consume: переиспользование отозванного → 401 и ВСЕ сессии юзера отозваны', async () => {
    const first = await service.issuePair(user);
    const second = await service.issuePair(user);
    await service.consume(first.refreshToken); // ротация

    await expect(service.consume(first.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );

    // reuse — улика компрометации: вторая, ни в чём не виноватая сессия, тоже гасится
    const secondRow = repo.rows.find(
      (r) => r.tokenHash === sha256(second.refreshToken),
    );
    expect(secondRow?.revokedAt).not.toBeNull();
  });

  it('consume: протухший токен → 401, строка удалена', async () => {
    const stale = 'stale-refresh-token';
    await repo.save(
      repo.create({
        userId: user.id,
        tokenHash: sha256(stale),
        expiresAt: new Date(Date.now() - 1000),
      }),
    );

    await expect(service.consume(stale)).rejects.toThrow('Сессия истекла');
    expect(
      repo.rows.find((r) => r.tokenHash === sha256(stale)),
    ).toBeUndefined();
  });

  it('consume: гонка параллельного refresh (UPDATE промахнулся) → 401 и ревок всех сессий', async () => {
    const mine = await service.issuePair(user);
    const other = await service.issuePair(user);

    // между нашим findOneBy и UPDATE токен уже ротировала «вторая рука»
    const realUpdate = repo.update.bind(repo);
    let patchedOnce = false;
    repo.update = async (where, set) => {
      if (!patchedOnce) {
        patchedOnce = true;
        return { affected: 0 };
      }
      return realUpdate(where, set);
    };

    await expect(service.consume(mine.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
    const otherRow = repo.rows.find(
      (r) => r.tokenHash === sha256(other.refreshToken),
    );
    expect(otherRow?.revokedAt).not.toBeNull();
  });

  it('revoke: гасит свою сессию, чужого юзера не трогает', async () => {
    const otherUser: User = {
      ...user,
      id: randomUUID(),
      email: 'bob@example.com',
    };
    const mine = await service.issuePair(user);
    const theirs = await service.issuePair(otherUser);

    await service.revoke(mine.refreshToken, user.id);
    // чужой токен под нашим userId — no-op, сессия другого человека жива
    await service.revoke(theirs.refreshToken, user.id);

    const mineRow = repo.rows.find(
      (r) => r.tokenHash === sha256(mine.refreshToken),
    );
    const theirsRow = repo.rows.find(
      (r) => r.tokenHash === sha256(theirs.refreshToken),
    );
    expect(mineRow?.revokedAt).not.toBeNull();
    expect(theirsRow?.revokedAt).toBeNull();
  });

  it('revokeAllForUser: отзывает живые, удаляет протухшие (ленивый GC)', async () => {
    const live = await service.issuePair(user);
    const stale = 'expired-but-not-revoked';
    await repo.save(
      repo.create({
        userId: user.id,
        tokenHash: sha256(stale),
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );

    await service.revokeAllForUser(user.id);

    const liveRow = repo.rows.find(
      (r) => r.tokenHash === sha256(live.refreshToken),
    );
    expect(liveRow?.revokedAt).not.toBeNull();
    expect(
      repo.rows.find((r) => r.tokenHash === sha256(stale)),
    ).toBeUndefined();
  });
});
