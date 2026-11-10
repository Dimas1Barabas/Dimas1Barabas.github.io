import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PostersStore, StoredPoster, posterKey } from './posters.store';

/**
 * Домен постеров: загрузка/раздача/удаление по id фильма. Деградация —
 * принцип этапа: хранилища нет или оно молчит → витрина получает null и
 * уходит на градиентный фолбэк (404), админские операции — честный 503.
 * Стенд без S3_ENDPOINT жив ровно как стенд с упавшим S3.
 */
@Injectable()
export class PostersService {
  private readonly logger = new Logger(PostersService.name);

  constructor(private readonly store: PostersStore | null) {}

  /** настроено ли хранилище (для свагера и самопроверок) */
  get enabled(): boolean {
    return this.store !== null;
  }

  async upload(
    movieId: string,
    body: Buffer,
    contentType: string,
  ): Promise<{ key: string; size: number }> {
    if (!this.store) {
      throw new ServiceUnavailableException(
        'хранилище постеров не настроено (S3_ENDPOINT)',
      );
    }
    const key = posterKey(movieId);
    try {
      await this.store.put(key, body, contentType);
    } catch (err) {
      this.logger.warn(`загрузка постера ${movieId} не удалась: ${String(err)}`);
      throw new ServiceUnavailableException('хранилище постеров недоступно');
    }
    return { key, size: body.length };
  }

  async poster(movieId: string): Promise<StoredPoster | null> {
    if (!this.store) return null;
    try {
      return await this.store.get(posterKey(movieId));
    } catch (err) {
      this.logger.warn(
        `постер ${movieId} недоступен: ${String(err)} — витрина на фолбэке`,
      );
      return null;
    }
  }

  async remove(movieId: string): Promise<boolean> {
    if (!this.store) {
      throw new ServiceUnavailableException(
        'хранилище постеров не настроено (S3_ENDPOINT)',
      );
    }
    try {
      return await this.store.remove(posterKey(movieId));
    } catch (err) {
      this.logger.warn(`удаление постера ${movieId} не удалось: ${String(err)}`);
      throw new ServiceUnavailableException('хранилище постеров недоступно');
    }
  }
}
