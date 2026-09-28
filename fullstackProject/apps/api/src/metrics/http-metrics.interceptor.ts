import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, finalize, tap, throwError } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * Глобальный интерцептор: каждый HTTP-запрос получает запись в гистограмму
 * длительности (method × шаблон маршрута × статус) и на время обработки
 * держит in-flight gauge. Не-HTTP контексты (ws-гейтвеи живой карты)
 * пропускает без изменений.
 *
 * Статус ошибки берётся из HttpException; всё, что не HttpException,
 * после exception-фильтров всё равно станет 500 — фиксируем сразу как 500.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const method: string = http.getRequest().method;
    const res = http.getResponse();
    const route = routeLabel(http.getRequest());

    const startedAt = process.hrtime.bigint();
    this.metrics.httpInFlight.inc();

    let observed = false;
    const observe = (status: number) => {
      if (observed) {
        return;
      }
      observed = true;
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics.httpDuration
        .labels(method, route, String(status))
        .observe(seconds);
      this.metrics.httpInFlight.dec();
    };

    return next.handle().pipe(
      // обычный путь: статус ответа уже известен после хендлера
      tap(() => observe(res.statusCode)),
      catchError((err) => {
        observe(err instanceof HttpException ? err.getStatus() : 500);
        return throwError(() => err);
      }),
      // страховка in-flight на случай, когда поток оборвали снаружи
      // (takeUntil/timeout) и ни tap, ни catchError не отработали
      finalize(() => observe(res.statusCode)),
    );
  }
}

/** шаблон маршрута вида /api/bookings/:id — без id, чтобы ряды не плодились */
function routeLabel(req: unknown): string {
  const route = (req as { route?: { path?: string } }).route?.path;
  return route ?? 'unmatched';
}
