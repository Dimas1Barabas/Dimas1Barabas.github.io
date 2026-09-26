/**
 * E2E инфраструктура: health и swagger — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, available } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

it('health: postgres, redis и rabbitmq живы', async () => {
  if (!available) return;
  const health = await api<{ status: string; checks: Record<string, string> }>('/health');
  expect(health.status).toBe('ok');
  expect(health.checks).toEqual({
    postgres: 'up',
    redis: 'up',
    rabbitmq: 'up',
  });
});

it('swagger: /docs отдаёт UI, /docs-json — OpenAPI 3 со всеми маршрутами', async () => {
  if (!available) return;
  // UI — открыто и без токена (api() бы прицепил Authorization)
  const ui = await fetch(`${BASE}/docs`);
  expect(ui.status).toBe(200);
  expect(ui.headers.get('content-type')).toContain('text/html');

  const spec = await api<{ openapi: string; paths: Record<string, unknown> }>('/docs-json');
  expect(spec.openapi).toMatch(/^3\./);
  expect(Object.keys(spec.paths)).toEqual(
    expect.arrayContaining(['/api/movies', '/api/bookings', '/api/auth/login']),
  );
});

