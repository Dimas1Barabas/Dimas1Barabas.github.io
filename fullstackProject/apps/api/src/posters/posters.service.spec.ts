import { ServiceUnavailableException } from '@nestjs/common';
import { PostersService } from './posters.service';
import { PostersStore, StoredPoster } from './posters.store';

/** Фейк стора: методы можно точечно ломать — деградация это ветки сервиса */
function fakeStore(overrides: Partial<Record<'put' | 'get' | 'remove', 'fail'>> = {}) {
  return {
    async put(key: string) {
      if (overrides.put === 'fail') throw new Error('connection refused');
      return `"${key.length}"`;
    },
    async get(key: string): Promise<StoredPoster | null> {
      if (overrides.get === 'fail') throw new Error('connection refused');
      return {
        buffer: Buffer.from(`bytes-of-${key}`),
        contentType: 'image/png',
        etag: '"abc"',
      };
    },
    async remove() {
      if (overrides.remove === 'fail') throw new Error('connection refused');
      return true;
    },
  } as unknown as PostersStore;
}

describe('PostersService (деградация вместо падения)', () => {
  it('без S3_ENDPOINT (null-стор) загрузка — 503, раздача — null, enabled=false', async () => {
    const svc = new PostersService(null);

    expect(svc.enabled).toBe(false);
    await expect(svc.upload('m-1', Buffer.from('a'), 'image/png')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(svc.poster('m-1')).resolves.toBeNull();
    await expect(svc.remove('m-1')).rejects.toThrow(ServiceUnavailableException);
  });

  it('живой стор: upload кладёт по posters/<id> и отдаёт размер', async () => {
    const put = jest.fn(async () => '"9"');
    const inner = fakeStore();
    Object.assign(inner, { put });
    const svc = new PostersService(inner);

    const res = await svc.upload('m-1', Buffer.from('png-bytes'), 'image/png');

    expect(put).toHaveBeenCalledWith('posters/m-1', expect.any(Buffer), 'image/png');
    expect(res).toEqual({ key: 'posters/m-1', size: 9 });
  });

  it('живой стор: poster отдаёт объект, remove — true', async () => {
    const svc = new PostersService(fakeStore());

    const poster = await svc.poster('m-1');
    expect(poster?.contentType).toBe('image/png');

    await expect(svc.remove('m-1')).resolves.toBe(true);
  });

  it('упавший S3: upload/remove — 503, poster — null (витрина уходит на фолбэк)', async () => {
    const svc = new PostersService(fakeStore({ put: 'fail', get: 'fail', remove: 'fail' }));

    await expect(svc.upload('m-1', Buffer.from('a'), 'image/png')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(svc.poster('m-1')).resolves.toBeNull();
    await expect(svc.remove('m-1')).rejects.toThrow(ServiceUnavailableException);
  });
});
