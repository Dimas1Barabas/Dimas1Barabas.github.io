import { Readable } from 'node:stream';
import { PostersStore, S3ClientSurface } from './posters.store';

type Stored = { body: Buffer; metaData: Record<string, string>; etag: string };

/** In-memory S3: считает вызовы и ведёт один бакет — как фейк int-уровня */
function fakeS3(initial: Record<string, Stored> = {}) {
  const calls = {
    bucketExists: 0,
    makeBucket: 0,
    putObject: 0,
    statObject: 0,
    removeObject: 0,
  };
  let bucketReady = false;
  let failMakeBucketOnce = false;
  const objects = new Map<string, Stored>(Object.entries(initial));

  const client: S3ClientSurface = {
    async bucketExists() {
      calls.bucketExists++;
      return bucketReady;
    },
    async makeBucket() {
      calls.makeBucket++;
      if (failMakeBucketOnce) {
        failMakeBucketOnce = false;
        throw new Error('S3 is down');
      }
      bucketReady = true;
    },
    async putObject(_bucket, key, body, _size, metaData) {
      calls.putObject++;
      const etag = `"${body.length.toString(16)}"`;
      objects.set(key, { body, metaData: metaData ?? {}, etag });
      return etag;
    },
    async statObject(_bucket, key) {
      calls.statObject++;
      const found = objects.get(key);
      if (!found) throw Object.assign(new Error('missing'), { code: 'NoSuchKey' });
      return { etag: found.etag, metaData: found.metaData };
    },
    async getObject(_bucket, key) {
      const found = objects.get(key);
      if (!found) throw Object.assign(new Error('missing'), { code: 'NoSuchKey' });
      return Readable.from([found.body]);
    },
    async removeObject(_bucket, key) {
      calls.removeObject++;
      const had = objects.delete(key);
      if (!had) throw Object.assign(new Error('missing'), { code: 'NoSuchKey' });
    },
  };
  return {
    client,
    calls,
    objects,
    failNextMakeBucket() {
      failMakeBucketOnce = true;
    },
  };
}

const config = {
  endpoint: 'http://seaweedfs:8333',
  accessKey: 'cine',
  secretKey: 'cine-poster-secret',
  bucket: 'cine-posters',
};

function store(client: S3ClientSurface): PostersStore {
  return new PostersStore(config, client);
}

describe('PostersStore', () => {
  it('put создаёт бакет при первом касании и кладёт объект с Content-Type', async () => {
    const s3 = fakeS3();
    const st = store(s3.client);

    const etag = await st.put('posters/m-1', Buffer.from('png-bytes'), 'image/png');

    expect(s3.calls.bucketExists).toBe(1);
    expect(s3.calls.makeBucket).toBe(1);
    expect(etag).toBe('"9"');
    expect(s3.objects.get('posters/m-1')).toMatchObject({
      metaData: { 'Content-Type': 'image/png' },
    });
  });

  it('ensure мемоится: вторая операция не переспрашивает бакет', async () => {
    const s3 = fakeS3();
    const st = store(s3.client);

    await st.put('posters/m-1', Buffer.from('a'), 'image/png');
    await st.put('posters/m-2', Buffer.from('b'), 'image/png');

    expect(s3.calls.bucketExists).toBe(1);
    expect(s3.calls.makeBucket).toBe(1);
    expect(s3.calls.putObject).toBe(2);
  });

  it('существующий бакет не пересоздаётся', async () => {
    const s3 = fakeS3();
    // бакет уже поднят: первая же ensure видит true
    await s3.client.makeBucket('cine-posters');
    s3.calls.bucketExists = 0;
    s3.calls.makeBucket = 0;
    const st = store(s3.client);

    await st.put('posters/m-1', Buffer.from('a'), 'image/png');

    expect(s3.calls.bucketExists).toBe(1);
    expect(s3.calls.makeBucket).toBe(0);
  });

  it('сбой ensure сбрасывает мемо — следующая операция пробует снова', async () => {
    const s3 = fakeS3();
    const st = store(s3.client);
    s3.failNextMakeBucket();

    await expect(st.put('posters/m-1', Buffer.from('a'), 'image/png')).rejects.toThrow('S3 is down');
    // бакет так и не создан, но мемо скинут: повтор поднимет
    await expect(st.put('posters/m-1', Buffer.from('a'), 'image/png')).resolves.toBe('"1"');

    expect(s3.calls.bucketExists).toBe(2);
    expect(s3.calls.makeBucket).toBe(2);
  });

  it('get отдаёт байты, сохранённый Content-Type и etag', async () => {
    const s3 = fakeS3();
    const st = store(s3.client);
    const body = Buffer.from('jpeg-bytes-here');
    await st.put('posters/m-1', body, 'image/jpeg');

    const poster = await st.get('posters/m-1');

    expect(poster).not.toBeNull();
    expect(poster!.buffer.equals(body)).toBe(true);
    expect(poster!.contentType).toBe('image/jpeg');
    expect(poster!.etag).toBe('"f"'); // фейковый etag = длина в hex: 15 байт
  });

  it('get: метаданные в нижнем регистре (как отдаёт SeaweedFS) тоже читаются', async () => {
    const s3 = fakeS3({
      'posters/m-1': {
        body: Buffer.from('x'),
        metaData: { 'content-type': 'image/webp' },
        etag: '"1"',
      },
    });
    await s3.client.makeBucket('cine-posters');
    const st = store(s3.client);

    const poster = await st.get('posters/m-1');

    expect(poster?.contentType).toBe('image/webp');
  });

  it('get отсутствующего постера — null (NoSuchKey), не сбой', async () => {
    const s3 = fakeS3();
    const st = store(s3.client);
    await st.put('posters/m-1', Buffer.from('a'), 'image/png');

    await expect(st.get('posters/ghost')).resolves.toBeNull();
  });

  it('remove: был объект — true, не было — false без ошибки', async () => {
    const s3 = fakeS3();
    const st = store(s3.client);
    await st.put('posters/m-1', Buffer.from('a'), 'image/png');

    await expect(st.remove('posters/m-1')).resolves.toBe(true);
    await expect(st.remove('posters/m-1')).resolves.toBe(false);
  });
});
