/**
 * Ссылка приглашения: hash-роутер — глубокая ссылка живёт после ?,
 * код маршрутизируется в#/login?ref=… и работает на GitHub Pages
 * без серверных редиректов (как сам роутер витрины).
 */
export function inviteLink(origin: string, code: string): string {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return `${base}#/login?ref=${encodeURIComponent(code)}`;
}
