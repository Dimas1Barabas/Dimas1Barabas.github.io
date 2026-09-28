import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Subject, of, throwError } from 'rxjs';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsService } from './metrics.service';

/**
 * Юнит-тесты интерцептора с фейковым ExecutionContext: проверяем
 * лейблы успешных/ошибочных запросов и возврат in-flight к нулю.
 */

interface FakeHttp {
  method: string;
  routePath?: string;
  statusCode: number;
}

function makeContext(http: FakeHttp): ExecutionContext {
  const req: Record<string, unknown> = { method: http.method };
  if (http.routePath !== undefined) {
    req.route = { path: http.routePath };
  }
  const res = { statusCode: http.statusCode };
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

describe('HttpMetricsInterceptor', () => {
  let service: MetricsService;
  let interceptor: HttpMetricsInterceptor;

  beforeEach(() => {
    service = new MetricsService();
    interceptor = new HttpMetricsInterceptor(service);
  });

  it('записывает успешный запрос с лейблами method/route/status', (done) => {
    const ctx = makeContext({ method: 'GET', routePath: '/api/movies', statusCode: 200 });

    interceptor.intercept(ctx, { handle: () => of('ok') }).subscribe({
      complete: async () => {
        const text = await service.metrics();
        expect(text).toContain(
          'cine_api_http_request_duration_seconds_count{method="GET",route="/api/movies",status="200"} 1',
        );
        expect(text).toContain('cine_api_http_requests_in_flight 0');
        done();
      },
    });
  });

  it('берёт статус из HttpException', (done) => {
    const ctx = makeContext({ method: 'DELETE', routePath: '/api/bookings/:id', statusCode: 200 });

    interceptor.intercept(ctx, { handle: () => throwError(() => new NotFoundException()) }).subscribe({
      error: async () => {
        const text = await service.metrics();
        expect(text).toContain(
          'cine_api_http_request_duration_seconds_count{method="DELETE",route="/api/bookings/:id",status="404"} 1',
        );
        expect(text).toContain('cine_api_http_requests_in_flight 0');
        done();
      },
    });
  });

  it('не-HttpException фиксируется как 500', (done) => {
    const ctx = makeContext({ method: 'POST', routePath: '/api/bookings', statusCode: 200 });

    interceptor.intercept(ctx, { handle: () => throwError(() => new Error('boom')) }).subscribe({
      error: async () => {
        const text = await service.metrics();
        expect(text).toContain(
          'cine_api_http_request_duration_seconds_count{method="POST",route="/api/bookings",status="500"} 1',
        );
        done();
      },
    });
  });

  it('без шаблона маршрута пишет unmatched', (done) => {
    const ctx = makeContext({ method: 'GET', statusCode: 200 });

    interceptor.intercept(ctx, { handle: () => of('ok') }).subscribe({
      complete: async () => {
        const text = await service.metrics();
        expect(text).toContain('route="unmatched"');
        done();
      },
    });
  });

  it('не-HTTP контекст проходит без записей', (done) => {
    const ctx = { getType: () => 'ws' } as unknown as ExecutionContext;

    interceptor.intercept(ctx, { handle: () => of('frame') }).subscribe({
      complete: async () => {
        const text = await service.metrics();
        expect(text).toContain('cine_api_http_requests_in_flight 0');
        expect(text).not.toContain('cine_api_http_request_duration_seconds_count{method=');
        done();
      },
    });
  });

  it('in-flight возвращается к нулю при обрыве потока', (done) => {
    const ctx = makeContext({ method: 'GET', routePath: '/api/movies', statusCode: 200 });

    const stream$ = interceptor.intercept(ctx, { handle: () => of('ok') });
    stream$.subscribe().unsubscribe();

    void (async () => {
      const text = await service.metrics();
      expect(text).toContain('cine_api_http_requests_in_flight 0');
      done();
    })();
  });

  // страховка finalize: поток оборвали снаружи до первого значения —
  // ни tap, ни catchError не отработали, но in-flight обязан уйти в ноль
  it('finalize страхует счётчик при отмене до ответа', (done) => {
    const ctx = makeContext({ method: 'GET', routePath: '/api/sessions', statusCode: 200 });

    const subscription = interceptor
      .intercept(ctx, { handle: () => new Subject() })
      .subscribe();
    subscription.unsubscribe();

    void (async () => {
      const text = await service.metrics();
      expect(text).toContain('cine_api_http_requests_in_flight 0');
      expect(text).toContain(
        'cine_api_http_request_duration_seconds_count{method="GET",route="/api/sessions",status="200"} 1',
      );
      done();
    })();
  });
});
