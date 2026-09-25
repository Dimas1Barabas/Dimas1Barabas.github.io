/**
 * Зеркало правил «Тарификатора» (services/pricing-service, Go).
 * Демо-движок считает цену теми же векторами, что и gRPC-сервис:
 * таблица проверки в pricing.spec.ts сверена с доменными тестами Go.
 * Часы сеанса — локальное время браузера: на стенде оно совпадает
 * с TZ сервиса (Europe/Moscow), на Pages демо живёт само в себе.
 */

/** Фактор раскладки цены: «вечерний прайм +20%» */
export interface PriceFactor {
  /** машинное имя: evening, weekend, demand_full … */
  code: 'morning' | 'evening' | 'weekend' | 'demand_low' | 'demand_high' | 'demand_full';
  /** человекочитаемая подпись — идентична Go-домену */
  label: string;
  /** вклад фактора, %: −20 … +25 */
  percent: number;
}

/** Расчёт цены места — как QuoteResponse Тарификатора */
export interface SessionQuote {
  sessionId: string;
  basePriceRub: number;
  priceRub: number;
  factors: PriceFactor[];
  occupied: number;
  capacity: number;
}

// пороги — как в internal/domain/pricing.go сервиса
const MORNING_HOUR_END = 12;
const EVENING_HOUR_BEG = 17;
const NIGHT_HOUR_BEG = 23;
const DEMAND_LOW_BELOW = 0.2;
const DEMAND_HIGH_ABOVE = 0.5;
const DEMAND_FULL_ABOVE = 0.8;

function timeFactor(at: Date): PriceFactor | null {
  const h = at.getHours();
  if (h < MORNING_HOUR_END) {
    return { code: 'morning', label: 'утренний сеанс −20%', percent: -20 };
  }
  if (h >= EVENING_HOUR_BEG && h < NIGHT_HOUR_BEG) {
    return { code: 'evening', label: 'вечерний прайм +20%', percent: 20 };
  }
  return null; // день и поздняя ночь — базовый тариф
}

function weekdayFactor(at: Date): PriceFactor | null {
  const wd = at.getDay(); // 0 — воскресенье, 6 — суббота
  if (wd === 0 || wd === 6) {
    return { code: 'weekend', label: 'выходной +10%', percent: 10 };
  }
  return null;
}

function demandFactor(occupied: number, capacity: number): PriceFactor | null {
  const share = occupied / capacity;
  if (share >= DEMAND_FULL_ABOVE) {
    return { code: 'demand_full', label: 'аншлаг +25%', percent: 25 };
  }
  if (share >= DEMAND_HIGH_ABOVE) {
    return { code: 'demand_high', label: 'спрос высокий +10%', percent: 10 };
  }
  if (share < DEMAND_LOW_BELOW) {
    return { code: 'demand_low', label: 'зал почти пуст −10%', percent: -10 };
  }
  return null;
}

/** Цена кратно десяти — как round10 в Go (half away from zero) */
function round10(v: number): number {
  return Math.round(v / 10) * 10;
}

/**
 * Цена места сеанса: база афиши × факторы времени суток, выходного
 * и заполненности зала. Чистая функция — одинаковые входы дают
 * одинаковую цену в демо и в live.
 */
export function quoteSession(input: {
  sessionId: string;
  /** момент сеанса, ISO */
  startsAt: string;
  basePriceRub: number;
  /** занятые места (в демо — карта занятости движка) */
  occupied: number;
  capacity: number;
}): SessionQuote {
  const occupied = Math.min(Math.max(input.occupied, 0), input.capacity);
  const at = new Date(input.startsAt);
  const factors: PriceFactor[] = [];
  let multiplier = 1;
  for (const factor of [timeFactor(at), weekdayFactor(at), demandFactor(occupied, input.capacity)]) {
    if (factor) {
      factors.push(factor);
      multiplier *= 1 + factor.percent / 100;
    }
  }
  return {
    sessionId: input.sessionId,
    basePriceRub: input.basePriceRub,
    priceRub: round10(input.basePriceRub * multiplier),
    factors,
    occupied,
    capacity: input.capacity,
  };
}
