import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

/**
 * Security-заголовки (Helmet) на каждом HTTP-ответе API: nosniff,
 * X-Frame-Options, HSTS, реферер-политика и CSP. API отдаёт JSON — CSP
 * по-настоящему исполняется браузером только на единственной HTML-странице
 * /api/docs, поэтому директивы настроены под Swagger UI:
 *   - init-скрипт и бандлы swagger-ui обслуживаются как отдельные файлы
 *     с того же origin → script-src 'self' хватает, unsafe-inline не нужен;
 *   - swagger-ui инжектит <style> из JS → style-src 'unsafe-inline';
 *   - логотип в CSS — data:URI → img-src data:.
 * JSON-ответы CSP не исполняют (браузер рисует их как текст), так что
 * ослабление style-src ничего не открывает для витрины и мутаций.
 *
 * HSTS включён дефолтом: по HTTP браузер его игнорирует, а на HTTPS-деплое
 * (этап «деплой в интернет») заработает сам без правок здесь.
 *
 * Вынесено из main.ts, чтобы int-харнессы поднимали приложение
 * в тех же условиях, что и прод, — спеки видят те же заголовки.
 */
export function setupHelmet(app: INestApplication): void {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          // дефолт helmet вносит upgrade-insecure-requests: браузер стал бы
          // апгрейдить сабресурсы docs на https и ронял их на http-стенде.
          // За https-деплоя страница сама https — апгрейдять нечего,
          // поэтому директиву снимаем явно
          upgradeInsecureRequests: null,
        },
      },
    }),
  );
}
