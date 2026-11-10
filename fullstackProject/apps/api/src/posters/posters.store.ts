import { Logger } from '@nestjs/common';
import { Client } from 'minio';
import { PostersConfig } from './posters.config';

/** Ключ постера детерминирован — из id фильма, назначений хранить не нужно */
export const posterKey = (movieId: string): string => `posters/${movieId}`;

/** Постер из бакета: байты + сохранённый при загрузке Content-Type + ETag */
export interface StoredPoster {
  buffer: Buffer;
  contentType: string;
  etag: string;
}

/** Поверхность клиента minio-js, нужная стору — фейки в спеках её повторяют */
export interface S3ClientSurface {
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string, region?: string): Promise<void>;
  putObject(
    bucket: string,
    key: string,
    body: Buffer,
    size?: number,
    metaData?: Record<string, string>,
  ): Promise<{ etag?: string } | string | undefined>;
  statObject(
    bucket: string,
    key: string,
  ): Promise<{ etag: string; metaData?: Record<string, string> }>;
  getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream>;
  removeObject(bucket: string, key: string): Promise<void>;
}

/** S3-ошибка «объекта нет» — штатный путь фолбэка, а не сбой */
function isNoSuchKey(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'NoSuchKey'
  );
}

/**
 * Тонкая обёртка над S3-клиентом постеров: ensure-бакет с мемоизацией
 * (сброс при сбое — стенд может подняться позже нас), put/get/remove
 * по ключу с Content-Type в метаданных. NoSuchKey отображается в null/
 * false — отсутствующий постер это фолбэк витрины, не ошибка стенда.
 */
export class PostersStore {
  private readonly logger = new Logger(PostersStore.name);
  private readonly client: S3ClientSurface;
  private readonly bucket: string;
  private ensured: Promise<void> | null = null;

  constructor(config: PostersConfig, client?: S3ClientSurface) {
    const url = new URL(config.endpoint);
    this.client =
      client ??
      new Client({
        endPoint: url.hostname,
        port: url.port
          ? Number(url.port)
          : url.protocol === 'https:'
            ? 443
            : 80,
        useSSL: url.protocol === 'https:',
        accessKey: config.accessKey,
        secretKey: config.secretKey,
      });
    this.bucket = config.bucket;
  }

  /**
   * Бакет есть/создан — гоняется раз за жизнь процесса; сбой сбрасывает
   * мемо, следующая операция попробует снова (retries без бэкоффа —
   * каждая операция сама решает, фолбэкнуться или отдать 503).
   */
  ensureBucket(): Promise<void> {
    this.ensured ??= (async () => {
      if (!(await this.client.bucketExists(this.bucket))) {
        await this.client.makeBucket(this.bucket);
        this.logger.log(`Создал бакет ${this.bucket}`);
      }
    })().catch((err: unknown) => {
      this.ensured = null;
      throw err;
    });
    return this.ensured;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.ensureBucket();
    // minio@8 отвечает UploadedObjectInfo; фейки в спеках — строкой etag
    const info = await this.client.putObject(
      this.bucket,
      key,
      body,
      body.length,
      { 'Content-Type': contentType },
    );
    return typeof info === 'string' ? info : (info?.etag ?? '');
  }

  async get(key: string): Promise<StoredPoster | null> {
    await this.ensureBucket();
    try {
      const stat = await this.client.statObject(this.bucket, key);
      const stream = await this.client.getObject(this.bucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }
      const md = stat.metaData ?? {};
      return {
        buffer: Buffer.concat(chunks),
        // SeaweedFS возвращает метаданные в нижнем регистре — ищем оба
        contentType: md['Content-Type'] ?? md['content-type'] ?? 'application/octet-stream',
        etag: stat.etag,
      };
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  async remove(key: string): Promise<boolean> {
    await this.ensureBucket();
    try {
      await this.client.removeObject(this.bucket, key);
      return true;
    } catch (err) {
      if (isNoSuchKey(err)) return false;
      throw err;
    }
  }
}
