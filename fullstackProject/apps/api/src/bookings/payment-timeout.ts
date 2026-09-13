/**
 * Окно оплаты брони: столько времени у клиента на оплату после создания.
 * Одно значение на два потребителя — аргумент x-message-ttl wait-очереди
 * (rabbit/rabbitmq.config) и expires_at брони (BookingsService.create).
 *
 * Читается из process.env напрямую, без ConfigService: конфиг Rabbit —
 * константа, вычисляемая на импорте модуля (как RABBITMQ_URL).
 */
export const DEFAULT_PAYMENT_TIMEOUT_MS = 15 * 60_000;

export function paymentTimeoutMs(): number {
  const raw = Number.parseInt(process.env.PAYMENT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PAYMENT_TIMEOUT_MS;
}
