import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FlagSnapshot, evaluateFlag } from './bucketing';
import { FLAG_CATALOG } from './flag-catalog';
import { FlagsClient } from './flags.client';

/**
 * Локальный вычислитель вердиктов поверх кэша состояний — паттерна
 * «SDK флаг-сервиса»: периодический ListFlags (TTL) + детерминированный
 * бакетинг на месте (зеркало домена Go). Следствия:
 *  - вердикт не ходит в сеть на каждый запрос — gRPC-шум только по TTL;
 *  - kill-switch вступает в силу за TTL кэша, а не «никогда»;
 *  - недоступность сервиса — работаем на прошлом снимке (fail-safe:
 *    новые фичи скрыты, деградация = замороженная раскатка, не офлайн).
 *
 * Попутно — саморегистрация: флаги из каталога, которых сервис ещё не
 * знает, создаются UpsertFlag'ом при первом опросе. Реестр фич живёт
 * в коде приложения, сервис хранит только состояние.
 */
@Injectable()
export class FlagsEvaluator implements OnModuleInit {
  private readonly logger = new Logger('FlagsEvaluator');
  private snapshots = new Map<string, FlagSnapshot>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly client: FlagsClient) {}

  /** Прогрев кэша на старте; сбой не валит API — вердикты до первого
   *  успешного опроса честно скажут not_found */
  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Вердикт флага для сущности (user id / email / ip — решает вызывающий) */
  async isEnabled(key: string, entityId: string) {
    if (Date.now() - this.fetchedAt > ttlMs()) {
      await this.refresh();
    }
    return evaluateFlag(this.snapshots.get(key), entityId);
  }

  /** Свежий снимок всех флагов (админке нужен список как есть) */
  async list(): Promise<FlagSnapshot[]> {
    if (Date.now() - this.fetchedAt > ttlMs()) {
      await this.refresh();
    }
    return [...this.snapshots.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * Засчитать экспозицию точки применения (витринный вердикт показан).
   * Fire-and-forget: метрики эксперимента не должны ни задерживать ответ,
   * ни ронять его — сбой сервиса уже погашен офлайн-снимком вердикта.
   */
  reportExposure(key: string, entityId: string): void {
    this.client.reportExposure(key, entityId).catch((err: unknown) => {
      this.logger.warn(`экспозиция ${key} не засчитана: ${String(err)}`);
    });
  }

  /** Засчитать конверсию (бизнес-событие после экспозиции) — та же семантика. */
  reportConversion(key: string, entityId: string): void {
    this.client.reportConversion(key, entityId).catch((err: unknown) => {
      this.logger.warn(`конверсия ${key} не засчитана: ${String(err)}`);
    });
  }

  /** Обновить кэш: снимок из сервиса + досоздать неизвестные флаги каталога */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const flags = await this.client.listFlags();
        const next = new Map(flags.map((f) => [f.key, f]));
        // саморегистрация: известные API фичи обязаны существовать в сервисе
        for (const item of FLAG_CATALOG) {
          if (!next.has(item.key)) {
            try {
              const created = await this.client.upsertFlag({ ...item, updatedBy: 'api:catalog' });
              next.set(item.key, created);
            } catch (err) {
              this.logger.warn(
                `саморегистрация ${item.key} не удалась: ${String(err)}`,
              );
            }
          }
        }
        this.snapshots = next;
        this.fetchedAt = Date.now();
      } catch (err) {
        // офлайн: остаёмся на прошлом снимке; после рестарта API без
        // сервиса вердикты — not_found, фичи скрыты (fail-safe)
        this.logger.warn(`Суфлёр недоступен, кэш не обновлён: ${String(err)}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

/** TTL кэша состояний: kill-switch применяется не дольше, чем за него */
function ttlMs(): number {
  const parsed = Number.parseInt(process.env.FLAGS_CACHE_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}
