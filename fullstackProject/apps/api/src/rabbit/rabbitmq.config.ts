import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';

/**
 * Динамический модуль RabbitMQ создаётся один раз и переиспользуется:
 * AppModule регистрирует подключение, BookingsModule — инжектит AmqpConnection.
 * (Nest дедуплицирует модули по классу, соединение будет одно.)
 */
export const rabbitMqModule = RabbitMQModule.forRoot({
  uri: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672/',
  exchanges: [
    {
      name: 'cinema',
      type: 'topic',
      createExchangeIfNotExists: true,
      options: { durable: true },
    },
  ],
  connectionInitOptions: { wait: true, reject: true, timeout: 60_000 },
});
