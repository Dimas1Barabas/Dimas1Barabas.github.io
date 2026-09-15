import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Swagger UI на /api/docs (спека — на /api/docs-json): под префиксом api,
 * поэтому доступен и напрямую (:13000), и через nginx-прокси (:18080).
 * Маршруты UI регистрируются в обход Nest-роутера — глобальный JwtAuthGuard
 * их не трогает, документация открыта как витрина.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('CineBooking API')
    .setDescription(
      'Бронирование билетов в кино: афиша с сеансами, карта зала, брони, ' +
        'lifecycle оплаты (резерв → оплата → вердикт воркера), отмена-сага, ' +
        'отзывы и рейтинги.\n\n' +
        'Витрина открыта всем; мутации — за Bearer-JWT: получите токен в ' +
        'POST /api/auth/login и нажмите **Authorize**.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);
}
