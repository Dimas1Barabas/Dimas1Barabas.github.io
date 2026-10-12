import { AnalyticsInsightsClient } from './analytics-insights.client';

/**
 * Клиент витрины Аналитика: недоступность и мусор — null (страница
 * рисует заглушку), валидный JSON — как есть.
 */
describe('AnalyticsInsightsClient', () => {
  let client: AnalyticsInsightsClient;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    client = new AnalyticsInsightsClient();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('отдаёт JSON витрины как есть', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ funnel: [] }), { status: 200 }),
    );
    const data = await client.insights();
    expect(data).toEqual({ funnel: [] });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/insights');
  });

  it('недоступность (сетевая ошибка) — null, не исключение', async () => {
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(client.insights()).resolves.toBeNull();
  });

  it('не-2xx ответ — null', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    await expect(client.insights()).resolves.toBeNull();
  });
});
