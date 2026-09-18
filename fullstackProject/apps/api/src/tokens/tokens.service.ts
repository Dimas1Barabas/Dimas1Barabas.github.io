import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { User, toUserDto, UserDto } from '../users/user.entity';
import { RefreshToken } from './refresh-token.entity';

/** сессия целиком: в тело ответа уходит без refreshToken (он — только в cookie) */
export interface SessionPair {
  accessToken: string;
  /** одноразовый refresh-токен; контроллер кладёт его в httpOnly-cookie */
  refreshToken: string;
  user: UserDto;
}

/** срок жизни refresh-сессии — 30 дней */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** в БД хранится только хэш: утёкшая база не даёт живых сессий */
const sha256 = (v: string): string =>
  createHash('sha256').update(v).digest('hex');

/**
 * TokensService — выдача и ротация пары «access + refresh».
 * Живёт в отдельном модуле: и auth, и users (смена пароля/профиль)
 * выдают свежие пары, а AuthModule и так импортирует UsersModule —
 * прямая зависимость создала бы цикл Nest.
 */
@Injectable()
export class TokensService {
  constructor(
    @InjectRepository(RefreshToken)
    private readonly tokens: Repository<RefreshToken>,
    private readonly jwt: JwtService,
  ) {}

  /** новая пара: короткоживущий JWT + одноразовый refresh на 30 дней */
  async issuePair(user: User): Promise<SessionPair> {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.tokens.save(
      this.tokens.create({
        userId: user.id,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      }),
    );
    return { accessToken, refreshToken, user: toUserDto(user) };
  }

  /**
   * Потребить refresh-токен (ротация): атомарно гасим его условным
   * UPDATE. Переиспользование уже отозванного токена считаем уликой
   * компрометации и ревокаем ВСЕ сессии пользователя.
   * Возвращает id владельца живой сессии.
   */
  async consume(raw: string): Promise<string> {
    const row = await this.tokens.findOneBy({ tokenHash: sha256(raw) });
    if (!row) {
      throw new UnauthorizedException('Сессия недействительна');
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.tokens.delete({ id: row.id });
      throw new UnauthorizedException('Сессия истекла');
    }
    if (row.revokedAt) {
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException('Сессия недействительна');
    }
    const res = await this.tokens.update(
      { id: row.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    if (!res.affected) {
      // гонка параллельных refresh: кто-то уже ротировал этот токен
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException('Сессия недействительна');
    }
    return row.userId;
  }

  /** выход: гасим конкретную сессию; чужой токен (не этого юзера) не трогаем */
  async revoke(raw: string, userId: string): Promise<void> {
    await this.tokens.update(
      { tokenHash: sha256(raw), userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  /** выход отовсюду (смена пароля / сброс / компрометация) + ленивая чистка */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.tokens.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    await this.tokens.delete({ userId, expiresAt: LessThan(new Date()) });
  }
}
