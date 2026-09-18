import type { Response } from 'express';
import { REFRESH_TTL_MS } from './tokens.service';

/**
 * Refresh-токен живёт в httpOnly-cookie: JS его не видит (XSS не унесёт
 * сессию), Path=/api/auth — кука ездит только на auth-роуты. SameSite=Lax
 * закрывает CSRF-отправку кукой с чужих сайтов.
 */
export const REFRESH_COOKIE = 'cine.refresh';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/api/auth',
  // TTL cookie равен TTL refresh-сессии — протухают одновременно
  maxAge: REFRESH_TTL_MS,
} as const;

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, COOKIE_OPTIONS);
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/auth',
  });
}
