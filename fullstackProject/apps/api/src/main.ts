import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';

/** откуда фронт ходит в API напрямую (без nginx/vite-прокси same-origin) */
const allowedOrigins = [
  'http://localhost:5173', // vite dev-сервер без прокси
  'http://127.0.0.1:5173',
  'http://localhost:18080', // nginx-стенд (обычно same-origin, но явный список честнее)
  'http://127.0.0.1:18080',
];

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api');
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
