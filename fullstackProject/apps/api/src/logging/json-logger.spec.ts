import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { JsonLogger } from './json-logger';

/**
 * JSON-логгер герметично: настоящий NodeTracerProvider с in-memory
 * экспортером (без него глобальный tracer — no-op и активного спана
 * не бывает), строки ловим спаем на process.stdout.write — ровно то,
 * что уедет в docker-лог и дальше в Loki.
 */

let exporter: InMemorySpanExporter;
let logger: JsonLogger;
let lines: string[];
let write: jest.SpyInstance;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

beforeEach(() => {
  logger = new JsonLogger();
  lines = [];
  write = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
});

afterEach(() => write.mockRestore());

/** последняя строка stdout, распарсенная как JSON-лог */
function lastEntry(): Record<string, unknown> {
  expect(lines.length).toBeGreaterThan(0);
  const line = lines[lines.length - 1]!.trim();
  expect(line.startsWith('{')).toBe(true); // никакой плоской болтовни
  return JSON.parse(line) as Record<string, unknown>;
}

describe('JsonLogger', () => {
  it('log/warn/debug пишут уровень, контекст и сообщение одной JSON-строкой', () => {
    logger.log('Бронь 42 подтверждена', 'BookingsService');
    expect(lastEntry()).toMatchObject({
      level: 'info',
      ctx: 'BookingsService',
      msg: 'Бронь 42 подтверждена',
    });
    expect(Object.keys(lastEntry())).toContain('time');
    expect(lastEntry()['trace_id']).toBeUndefined(); // вне спана — поля нет

    logger.warn('Тарификатор недоступен', 'BookingsService');
    expect(lastEntry()['level']).toBe('warn');
    logger.debug('детали', 'BookingsService');
    expect(lastEntry()['level']).toBe('debug');
  });

  it('error несёт stack отдельным полем', () => {
    logger.error('бронь не прошла', 'Error: x\n  at f', 'BookingsService');
    expect(lastEntry()).toMatchObject({
      level: 'error',
      ctx: 'BookingsService',
      msg: 'бронь не прошла',
      stack: 'Error: x\n  at f',
    });
  });

  it('вне активного спана trace_id/span_id не пишутся', () => {
    logger.log('запуск без трейсинга', 'Bootstrap');
    const entry = lastEntry();
    expect(entry['trace_id']).toBeUndefined();
    expect(entry['span_id']).toBeUndefined();
  });

  it('под активным спаном строка несёт его trace_id/span_id', async () => {
    const span = trace.getTracer('spec').startSpan('http GET /api/bookings');
    let entry: Record<string, unknown> = {};
    await context.with(trace.setSpan(context.active(), span), async () => {
      logger.log('внутри запроса', 'BookingsService');
      entry = lastEntry();
    });
    span.end();

    expect(entry['trace_id']).toBe(span.spanContext().traceId);
    expect(entry['span_id']).toBe(span.spanContext().spanId);
  });

  it('объект-сообщение не разваливается в «[object Object]»', () => {
    logger.log({ seats: ['1', '2'] }, 'SeatMapGateway');
    expect(lastEntry()['msg']).toEqual('{"seats":["1","2"]}');
  });
});
