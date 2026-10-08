import type { Response } from 'express';
import { REFRESH_COOKIE, clearRefreshCookie, setRefreshCookie } from './cookies';
import { REFRESH_TTL_MS } from './tokens.service';

/**
 * Флаги refresh-cookie: httpOnly/SameSite/Path — всегда, Secure — только
 * за env COOKIE_SECURE=true (https-деплой). Ответ — мок: интересуют
 * опции res.cookie, а не рендер Set-Cookie-строки.
 */

describe('refresh-cookie: флаги set/clear', () => {
  const original = process.env.COOKIE_SECURE;

  afterEach(() => {
    if (original === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = original;
  });

  function fakeRes(): { res: Response; cookie: jest.Mock; clearCookie: jest.Mock } {
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    return { res: { cookie, clearCookie } as unknown as Response, cookie, clearCookie };
  }

  it('http-стенд (env не задан): httpOnly + SameSite=Lax, без Secure', () => {
    delete process.env.COOKIE_SECURE;
    const { res, cookie } = fakeRes();

    setRefreshCookie(res, 'refresh-token');

    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh-token',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/api/auth',
        secure: false,
        maxAge: REFRESH_TTL_MS,
      }),
    );
  });

  it('COOKIE_SECURE=true: кука едет с Secure (https-деплой за TLS-прокси)', () => {
    process.env.COOKIE_SECURE = 'true';
    const { res, cookie } = fakeRes();

    setRefreshCookie(res, 'refresh-token');

    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh-token',
      expect.objectContaining({ secure: true }),
    );
  });

  it('logout гасит куку теми же флагами — иначе браузер не найдёт её', () => {
    process.env.COOKIE_SECURE = 'true';
    const { res, clearCookie } = fakeRes();

    clearRefreshCookie(res);

    expect(clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: '/api/auth',
        secure: true,
      }),
    );
  });
});
