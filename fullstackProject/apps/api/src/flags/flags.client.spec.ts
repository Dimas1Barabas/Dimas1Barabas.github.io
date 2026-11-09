import { FlagsClient, UpsertFlagInput } from './flags.client';
import { FlagSnapshot } from './bucketing';

/**
 * Конструктор живой: грузит настоящий .proto и строит gRPC-клиента
 * (соединение ленивое — без вызовов сети нет). Стаб подменяет только
 * transport-слой: каждый вызов записывается (запрос + дедлайн), ответ
 * или ошибка управляются тестом.
 */

/** Зафиксированный вызов: метод, запрос, дедлайн (мс от эпохи) */
interface Captured {
  method:
    | 'Evaluate'
    | 'ListFlags'
    | 'UpsertFlag'
    | 'DeleteFlag'
    | 'ReportExposure'
    | 'ReportConversion';
  request: unknown;
  deadline: number;
}

type Answer = { err?: Error; res?: unknown };

const snap: FlagSnapshot = {
  key: 'checkout.new_flow',
  description: 'новый чекаут',
  enabled: true,
  percentage: 15,
  killed: false,
  updatedBy: 'qa',
  updatedAt: '2026-11-02T12:00:00Z',
};

function makeClient(answer: (method: string, request: unknown) => Answer) {
  const client = new FlagsClient();
  const real = (client as unknown as { stub: unknown }).stub;
  const calls: Captured[] = [];
  const record =
    (method: Captured['method']) =>
    (
      request: unknown,
      options: { deadline: Date },
      cb: (err: Error | null, res: unknown) => void,
    ) => {
      calls.push({ method, request, deadline: options.deadline.getTime() });
      const { err, res } = answer(method, request);
      cb(err ?? null, res);
    };
  (client as unknown as { stub: unknown }).stub = {
    Evaluate: record('Evaluate'),
    ListFlags: record('ListFlags'),
    UpsertFlag: record('UpsertFlag'),
    DeleteFlag: record('DeleteFlag'),
    ReportExposure: record('ReportExposure'),
    ReportConversion: record('ReportConversion'),
  };
  return {
    client,
    calls,
    /** настоящий gRPC-клиент (до подмены) — закрыть в конце, чистоты ради */
    close() {
      (real as { close?: () => void }).close?.();
    },
  };
}

describe('FlagsClient', () => {
  const opened: ReturnType<typeof makeClient>[] = [];

  afterEach(() => {
    opened.forEach((c) => c.close());
    opened.length = 0;
    delete process.env.GRPC_FLAGS_TIMEOUT_MS;
    delete process.env.GRPC_FLAGS_URL;
  });

  /** клиент с записью вызовов + гарантированным закрытием */
  function tracked(answer: (method: string, request: unknown) => Answer) {
    const made = makeClient(answer);
    opened.push(made);
    return made;
  }

  it('конструктор грузит контракт и строит клиента без соединения', () => {
    const { client } = tracked(() => ({ res: {} }));
    expect(client).toBeInstanceOf(FlagsClient);
  });

  it('evaluate: ключ и сущность уходят в сервис, вердикт возвращается', async () => {
    const { client, calls } = tracked(() => ({
      res: { enabled: true, reason: 'on', percentage: 100 },
    }));
    await expect(
      client.evaluate('checkout.new_flow', 'user-1'),
    ).resolves.toEqual({ enabled: true, reason: 'on', percentage: 100 });
    expect(calls[0]).toMatchObject({
      method: 'Evaluate',
      request: { key: 'checkout.new_flow', entityId: 'user-1' },
    });
  });

  it('evaluate: дефолтный дедлайн — 1 секунда', async () => {
    const { client, calls } = tracked(() => ({ res: {} }));
    await client.evaluate('f', 'u');
    const slack = calls[0].deadline - Date.now();
    expect(slack).toBeGreaterThan(500); // в будущем, но не просрочен
    expect(slack).toBeLessThanOrEqual(1000);
  });

  it('ошибка gRPC отклоняет промис (наверху — fail-safe кэша)', async () => {
    const { client } = tracked(() => ({ err: new Error('14 UNAVAILABLE: Суфлёр упал') }));
    await expect(client.evaluate('f', 'u')).rejects.toThrow('UNAVAILABLE');
  });

  it('listFlags: снимки всех флагов; пустой ответ — пустой список', async () => {
    let empty = false;
    const { client } = tracked(() => (empty ? { res: {} } : { res: { flags: [snap] } }));
    await expect(client.listFlags()).resolves.toEqual([snap]);
    empty = true; // сервис ответил без поля flags (?? [])
    await expect(client.listFlags()).resolves.toEqual([]);
  });

  it('upsertFlag: полное состояние уходит, снимок возвращается', async () => {
    const { client, calls } = tracked(() => ({ res: snap }));
    const input: UpsertFlagInput = {
      key: 'checkout.new_flow',
      description: 'новый чекаут',
      enabled: true,
      percentage: 40,
      killed: false,
      updatedBy: 'admin@cine.local',
    };
    await expect(client.upsertFlag(input)).resolves.toEqual(snap);
    expect(calls[0]).toMatchObject({ method: 'UpsertFlag', request: input });
  });

  it('deleteFlag: ключ уходит, флаг удаления возвращается', async () => {
    const { client, calls } = tracked(() => ({ res: { deleted: true } }));
    await expect(client.deleteFlag('checkout.new_flow')).resolves.toEqual({ deleted: true });
    expect(calls[0]).toMatchObject({
      method: 'DeleteFlag',
      request: { key: 'checkout.new_flow' },
    });
  });

  it('reportExposure/reportConversion: ключ и сущность уходят, вариант возвращается', async () => {
    const { client, calls } = tracked((method) => ({
      res: { variant: method === 'ReportExposure' ? 'a' : '', counted: true },
    }));
    await expect(
      client.reportExposure('booking.qr_v2', 'user-2'),
    ).resolves.toEqual({ variant: 'a', counted: true });
    await expect(
      client.reportConversion('booking.qr_v2', 'user-1'),
    ).resolves.toEqual({ variant: '', counted: true });
    // вариант НЕ присылаем — его считает сервис из бакетинга
    expect(calls).toMatchObject([
      { method: 'ReportExposure', request: { key: 'booking.qr_v2', entityId: 'user-2' } },
      { method: 'ReportConversion', request: { key: 'booking.qr_v2', entityId: 'user-1' } },
    ]);
  });

  it('upsertFlag с вариантами: список уходит как есть (полное состояние)', async () => {
    const { client, calls } = tracked(() => ({ res: snap }));
    const input: UpsertFlagInput = {
      key: 'booking.qr_v2',
      description: 'A/B QR',
      enabled: true,
      percentage: 0,
      killed: false,
      variants: [
        { name: 'a', percentage: 10 },
        { name: 'b', percentage: 30 },
      ],
      updatedBy: 'qa',
    };
    await expect(client.upsertFlag(input)).resolves.toEqual(snap);
    expect(calls[0]).toMatchObject({ method: 'UpsertFlag', request: input });
  });

  it('GRPC_FLAGS_TIMEOUT_MS задаёт дедлайн; мусор и ноль — дефолт 1 c', async () => {
    const { client, calls } = tracked(() => ({ res: {} }));

    process.env.GRPC_FLAGS_TIMEOUT_MS = '5000';
    await client.evaluate('f', 'u');
    expect(calls[0].deadline - Date.now()).toBeGreaterThan(4000);

    process.env.GRPC_FLAGS_TIMEOUT_MS = 'не-число';
    await client.evaluate('f', 'u');
    expect(calls[1].deadline - Date.now()).toBeLessThanOrEqual(1000);

    process.env.GRPC_FLAGS_TIMEOUT_MS = '0'; // неположительный — тоже дефолт
    await client.evaluate('f', 'u');
    expect(calls[2].deadline - Date.now()).toBeLessThanOrEqual(1000);
  });

  it('GRPC_FLAGS_URL переопределяет адрес — клиент строится и работает', async () => {
    process.env.GRPC_FLAGS_URL = 'flags:8095'; // как в compose-сети стенда
    const { client } = tracked(() => ({ res: { flags: [snap] } }));
    await expect(client.listFlags()).resolves.toEqual([snap]);
  });
});
