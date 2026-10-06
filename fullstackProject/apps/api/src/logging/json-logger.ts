import type { LoggerService } from '@nestjs/common';
import {
  context as otelContext,
  isSpanContextValid,
  trace,
} from '@opentelemetry/api';

/**
 * JSON-логгер вместо дефолтного ConsoleLogger: каждая строка — объект
 * { time, level, ctx, msg, trace_id?, span_id? } — его парсит Alloy
 * (stage.json) и складывает в Loki, где по trace_id строка линкуется
 * в трейс Jaeger. trace_id/span_id берутся из активного OTel-спана
 * (AsyncHooks-контекстменеджер несёт его через все await цепочки),
 * вне спана поля просто опускаются.
 *
 * Точки вызова не меняются: `new Logger(ClassName.name)` у сервисов
 * маршрутизируется глобальным логгером Nest (NestFactory.create(AppModule,
 * { logger }) ) — формат меняется в одном месте.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, { context: optionalParams[0] });
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, { context: optionalParams[0] });
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    // Nest зовёт error(message, stack, context)
    this.write('error', message, {
      stack: optionalParams[0],
      context: optionalParams[1],
    });
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, { context: optionalParams[0] });
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, { context: optionalParams[0] });
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, {
      stack: optionalParams[0],
      context: optionalParams[1],
    });
  }

  private write(
    level: string,
    message: unknown,
    extra: { stack?: unknown; context?: unknown } = {},
  ): void {
    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      ctx: typeof extra.context === 'string' ? extra.context : undefined,
      msg: toMessage(message),
    };

    const spanContext = trace.getSpan(otelContext.active())?.spanContext();
    if (spanContext && isSpanContextValid(spanContext)) {
      entry.trace_id = spanContext.traceId;
      entry.span_id = spanContext.spanId;
    }
    if (typeof extra.stack === 'string' && extra.stack) {
      entry.stack = extra.stack;
    }

    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}

/** сообщение может прийти объектом — оставляем его структуру значением msg */
function toMessage(message: unknown): unknown {
  return typeof message === 'string' ? message : JSON.stringify(message);
}
