import { Logger } from '@nestjs/common';
import { FlagsRevisionsClient, FlagRevision } from './flags-revisions.client';

/**
 * HTTP-витрина аудита — это fetch + деградация в пустую историю:
 * любой сбой (ошибка сети, не-2xx, кривое тело) не должен ронять
 * админку. Спека прогоняет все пути деградации.
 */

const realFetch = global.fetch;

const rev: FlagRevision = {
  key: 'checkout.new_flow',
  changedBy: 'qa',
  changedAt: '2026-11-02T12:00:00Z',
  snapshot: { enabled: true, percentage: 15, killed: false },
};

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** fetch-стаб: помнит вызовы, отвечает заготовкой */
function fetchAnswer(make: () => Response) {
  const mock = jest.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    make(),
  );
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('FlagsRevisionsClient', () => {
  let warns: string[];

  beforeEach(() => {
    warns = [];
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(((m: unknown) => {
        warns.push(String(m));
        return undefined as never;
      }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = realFetch;
    delete process.env.FLAGS_HTTP_URL;
  });

  it('аудит свежими сверху: ключ и дефолтный limit в запросе', async () => {
    const mock = fetchAnswer(() => ok({ revisions: [rev] }));
    const client = new FlagsRevisionsClient();

    await expect(client.revisions('checkout.new_flow')).resolves.toEqual([rev]);
    expect(String(mock.mock.calls[0][0])).toBe(
      'http://localhost:18096/flags/revisions?key=checkout.new_flow&limit=20',
    );
  });

  it('ключ кодируется, limit настраивается', async () => {
    const mock = fetchAnswer(() => ok({ revisions: [] }));
    const client = new FlagsRevisionsClient();

    await expect(client.revisions('new flow', 5)).resolves.toEqual([]);
    expect(String(mock.mock.calls[0][0])).toContain('key=new%20flow&limit=5');
  });

  it('FLAGS_HTTP_URL переопределяет базу витрины (compose-сеть)', async () => {
    process.env.FLAGS_HTTP_URL = 'http://flags:18096';
    const mock = fetchAnswer(() => ok({ revisions: [rev] }));

    await new FlagsRevisionsClient().revisions('checkout.new_flow');
    expect(String(mock.mock.calls[0][0])).toContain(
      'http://flags:18096/flags/revisions',
    );
  });

  it('нет поля revisions — пустая история', async () => {
    fetchAnswer(() => ok({}));
    await expect(new FlagsRevisionsClient().revisions('k')).resolves.toEqual([]);
  });

  it('витрина ответила ошибкой — пустая история и предупреждение', async () => {
    fetchAnswer(() => new Response('boom', { status: 503 }));
    const client = new FlagsRevisionsClient();

    await expect(client.revisions('k')).resolves.toEqual([]);
    expect(warns.join(' | ')).toContain('HTTP 503');
  });

  it('витрина недоступна — пустая история и предупреждение', async () => {
    fetchAnswer(() => {
      throw new Error('fetch failed');
    });
    const client = new FlagsRevisionsClient();

    await expect(client.revisions('k')).resolves.toEqual([]);
    expect(warns.join(' | ')).toContain('витрина аудита недоступна');
  });
});
