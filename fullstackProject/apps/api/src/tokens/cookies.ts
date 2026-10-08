import type { CookieOptions, Response } from 'express';
import { REFRESH_TTL_MS } from './tokens.service';

/**
 * Refresh-токен живёт в httpOnly-cookie: JS его не видит (XSS не унесёт
 * сессию), Path=/api/auth — кука ездит только на auth-роуты. SameSite=Lax
 * закрывает CSRF-отправку кукой с чужих сайтов.
 *
 * Secure — за env COOKIE_SECURE=true: на https-деплое (за TLS-прокси)
 * браузер примет куку только по https; на http-стенде флаг выключен —
 * иначе кука с Secure по http просто не сохранится и вход развалится.
 * Читаем на момент вызова, не на импорт модуля, — env приложения
 * разворачивается раньше первого логина.
 */
export const REFRESH_COOKIE = 'cine.refresh';

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api/auth',
    secure: process.env.COOKIE_SECURE === 'true',
    // TTL cookie равен TTL refresh-сессии — протухают одновременно
    maxAge: REFRESH_TTL_MS,
  };
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions());
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}
