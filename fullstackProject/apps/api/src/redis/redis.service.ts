import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.module';

export type CacheSource = 'cache' | 'db';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    await this.redis.del(...keys);
  }

  /**
   * Читает значение из кэша; при промахе грузит из БД через loader
   * и кладёт в Redis с TTL. Возвращает источник — видно в ответе API.
   */
  async withCache<T>(
    key: string,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<{ value: T; source: CacheSource }> {
    const cached = await this.getJson<T>(key);
    if (cached !== null) {
      return { value: cached, source: 'cache' };
    }

    const value = await loader();
    try {
      await this.setJson(key, value, ttlSeconds);
    } catch (err) {
      this.logger.warn(
        `Не удалось записать кэш ${key}: ${(err as Error).message}`,
      );
    }
    return { value, source: 'db' };
  }
}
