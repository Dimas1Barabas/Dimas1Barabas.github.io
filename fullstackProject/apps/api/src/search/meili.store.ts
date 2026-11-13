import { SearchConfig } from './search.config';

/** документ индекса movies_v1: подсказке витрины нужен ровно этот набор */
export type MovieDoc = {
  id: string;
  title: string;
  description: string;
  genre: string;
  genreIcon: string;
  hue: number;
  ratingAvg: number;
};

/** имя индекса с версией схемы: меняем состав документа — катим новое
 *  имя, старые доки не доживают в новом формате (как movie:v3) */
export const MOVIES_INDEX = 'movies_v1';

/** ответ на постановку задачи (202): ключ называется taskUid… */
interface EnqueuedTask {
  taskUid: number;
}

/** …а в самой задаче (GET /tasks/:uid) — уже uid; Meili асинхронный */
interface MeiliTask {
  uid: number;
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed';
  error?: { message?: string; code?: string };
}

/**
 * Тонкий REST-клиент Meilisearch на глобальном fetch — без SDK: пакет
 * meilisearch (0.63) поставляется ESM-only (type: module, без main),
 * а API собирается в CommonJS — require его не поднимет, а менять
 * moduleResolution всего проекта под одну зависимость не стоит. Нужный
 * кусок протокола — пять маршрутов.
 *
 * Записи асинхронны: каждая возвращает задачу, write-операции ждём
 * поллингом — к возврату индекс уже отвечает поиском (бут и live-тесты
 * не гоняются с индексацией). Ошибки НЕ глотаем: деградацию на фолбэк
 * решает SearchService — то же разделение, что PostersStore/PostersService.
 */
export class MeiliStore {
  constructor(private readonly config: SearchConfig) {}

  /** JSON-вызов REST API; не-2xx — ошибка с телом Meilisearch */
  private async call<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.config.host}${path}`, {
        ...init,
        // спред init затёр бы свои заголовки — сливаем (урок этапа 29)
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(this.config.apiKey
            ? { Authorization: `Bearer ${this.config.apiKey}` }
            : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Meilisearch ${res.status}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** дождаться задачи: до succeeded поиск не видит свежих доков */
  private async waitTask(uid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = await this.call<MeiliTask>(`/tasks/${uid}`);
      if (task.status === 'succeeded') return;
      if (task.status === 'failed') {
        throw new Error(
          `задача ${uid} не удалась: ${task.error?.message ?? task.error?.code ?? 'без описания'}`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`задача ${uid} не завершилась за ${timeoutMs}мс`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** индекс + настройки поиска; идемпотентен — применяется на каждом
   *  буте. Настройки несуществующего индекса создают его. Порядок
   *  атрибутов = вес релевантности: совпадение в названии ранжируется
   *  выше совпадения в описании */
  async ensureIndex(): Promise<void> {
    const task = await this.call<EnqueuedTask>(
      `/indexes/${MOVIES_INDEX}/settings/searchable-attributes`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['title', 'description', 'genre']),
      },
    );
    await this.waitTask(task.taskUid, 10_000);
  }

  /** полная пересборка индекса: чистый лист + все документы разом.
   *  delete-all обязателен: посев после TRUNCATE создаёт фильмы с новыми
   *  uuid, upsert оставил бы призраков прошлой эпохи в подсказках */
  async rebuild(docs: MovieDoc[]): Promise<void> {
    const del = await this.call<EnqueuedTask>(
      `/indexes/${MOVIES_INDEX}/documents`,
      { method: 'DELETE' },
    );
    await this.waitTask(del.taskUid, 10_000);
    const add = await this.call<EnqueuedTask>(
      `/indexes/${MOVIES_INDEX}/documents?primaryKey=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(docs),
      },
      30_000,
    );
    await this.waitTask(add.taskUid, 30_000);
  }

  /** upsert одного документа (новый фильм, свежий рейтинг после отзыва) */
  async upsert(doc: MovieDoc): Promise<void> {
    const task = await this.call<EnqueuedTask>(
      `/indexes/${MOVIES_INDEX}/documents?primaryKey=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([doc]),
      },
    );
    await this.waitTask(task.taskUid, 10_000);
  }

  /** поиск-подсказки; бросается — сервис уйдёт на фолбэк */
  async search(q: string, limit: number): Promise<MovieDoc[]> {
    const res = await this.call<{ hits: MovieDoc[] }>(
      `/indexes/${MOVIES_INDEX}/search`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, limit }),
      },
    );
    return res.hits;
  }
}
