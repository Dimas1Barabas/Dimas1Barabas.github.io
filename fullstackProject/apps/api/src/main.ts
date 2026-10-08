import 'reflect-metadata';
// OTel-SDK до загрузки Nest/express: инструментация патчит модули при require
import './tracing/setup-tracing';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { JsonLogger } from './logging/json-logger';
import { setupHelmet } from './security/helmet';
import { setupSwagger } from './swagger';

/** откуда фронт ходит в API напрямую (без nginx/vite-прокси same-origin) */
const allowedOrigins = [
  'http://localhost:5173', // vite dev-сервер без прокси
  'http://127.0.0.1:5173',
  'http://localhost:18080', // nginx-стенд (обычно same-origin, но явный список честнее)
  'http://127.0.0.1:18080',
];

async function bootstrap(): Promise<void> {
  // JSON-строки вместо плоского ConsoleLogger: со стартовых сообщений,
  // пока Nest молотит инициализацию модулей (Loki парсит их же)
  const app = await NestFactory.create(AppModule, {
    logger: new JsonLogger(),
  });

  app.setGlobalPrefix('api');
  // security-заголовки до роутов: helmet — обычная express-middleware
  setupHelmet(app);
  // ws-гейтвеи (живая карта мест /api/seats) — на общем HTTP-сервере:
  // префикс 'api' на них не действует, путь задан в самом гейтвее
  app.useWebSocketAdapter(new WsAdapter(app));
  // refresh-cookie ездит с запросами — credentials + явный список origin
  // (отражение origin при credentials браузеры принимают, а '*' — нет)
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  setupSwagger(app);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  new Logger('Bootstrap').log(
    `CineBooking API: http://localhost:${port}/api (docs: /api/docs)`,
  );
}

void bootstrap();
