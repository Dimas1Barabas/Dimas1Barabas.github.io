/** Контракты сообщений кинобара (обмен «cinema», topic) */

/**
 * API → Бармен: routing key «bar.order.created». Заказ оформлен, остатки
 * уже списаны (та же транзакция). Бармен кладёт заказ в очередь на экран
 * бара. customerName/email — для витрины и будущего «письма» о готовности
 * (BarOrderStatusEvent переложит их дальше), sessionAt/hall — подсказка
 * «выдать к сеансу». MessageId публикации — uuid outbox-записи (Курьер).
 */
export interface BarOrderCreatedEvent {
  orderId: string;
  userId: string;
  customerName: string;
  email: string;
  /** сеанс, к которому приготовить; null — забрать на стойке */
  sessionId: string | null;
  /** время сеанса, ISO; null при заказе «без сеанса» */
  sessionAt: string | null;
  hall: string | null;
  items: { itemId: string; name: string; priceRub: number; qty: number }[];
  totalRub: number;
  createdAt: string;
}

/**
 * Бармен → API (и notification-service): routing key «bar.order.status».
 * Статусные переходы после оформления: PREPARING / READY / PICKED_UP.
 * READY параллельно читает notification-service — «письмо» «заказ готов,
 * ждём на стойке бара» (email Бармен взял из BarOrderCreatedEvent).
 */
export interface BarOrderStatusEvent {
  orderId: string;
  status: 'PREPARING' | 'READY' | 'PICKED_UP';
  /** адресат «письма» о готовности; прочим статусам не нужен */
  email: string;
  customerName: string;
  changedAt: string;
}

/**
 * API → Бармен: routing key «bar.order.cancelled». Владелец отменил заказ
 * (возможно только на NEW/PREPARING): API уже вернул остатки на склад,
 * Бармен убирает заказ из очереди, ничего не готовя.
 */
export interface BarOrderCancelledEvent {
  orderId: string;
  cancelledAt: string;
}
