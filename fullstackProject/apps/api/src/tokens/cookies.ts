import type { CookieOptions, Response } from 'express';
import { DEVICE_TTL_MS } from '../twofactor/twofactor.service';
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

/**
 * Доверенное устройство 2FA (этап 34): httpOnly-кука с токеном — как
 * refresh, JS не видит. Рядом кладём нечувствительную куку с id строки
 * (не httpOnly): витрина профиля помечает «это устройство» в списке,
 * сравнивая id — сам токен наружу не выходит.
 */
export const DEVICE_COOKIE = 'cine.device';
export const DEVICE_ID_COOKIE = 'cine.device.id';

export function setDeviceCookies(res: Response, token: string, id: string): void {
  const options = cookieOptions();
  res.cookie(DEVICE_COOKIE, token, options);
  res.cookie(DEVICE_ID_COOKIE, id, {
    ...options,
    httpOnly: false,
    maxAge: DEVICE_TTL_MS,
  });
}

export function clearDeviceCookies(res: Response): void {
  const options = cookieOptions();
  res.clearCookie(DEVICE_COOKIE, options);
  res.clearCookie(DEVICE_ID_COOKIE, { ...options, httpOnly: false });
}
