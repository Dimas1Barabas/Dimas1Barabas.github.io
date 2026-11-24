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
  /** итог к оплате — уже за вычетом скидки уровня «Киноман» (этап 38) */
  totalRub: number;
  /** применённая скидка уровня, % (0 — Новичок); экрану бара для ценника */
  loyaltyDiscountPercent: number;
  createdAt: string;
}

/**
 * Бармен → API (и notification-service): routing key по одному на
 * переход — bar.order.preparing / bar.order.ready / bar.order.picked_up
 * (топик-обмен даёт читателям свою выборку: API слушает все три,
 * notification — только ready для «письма»). Статус дублируется полем.
 */
export interface BarOrderStatusEvent {
  orderId: string;
  status: 'PREPARING' | 'READY' | 'PICKED_UP';
  /** адресат «письма» о готовности (шлёт notification на ready) */
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
