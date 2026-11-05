/**
 * Каталог продуктовых флагов CineBooking: кто здесь есть, что делает
 * фича и с какого состояния начинать раскатку. Реестр живёт в коде API —
 * приложение само регистрирует свои фичи в «Суфлёре» (UpsertFlag для
 * отсутствующих при первом опросе), сервис хранит только состояние.
 *
 * Новый флаг добавляется строкой сюда + точкой применения (@FeatureFlag
 * на маршруте или isEnabled в сервисе) — админка увидит его сама.
 */

export interface CatalogFlag {
  key: string;
  description: string;
  /** стартовое состояние при саморегистрации: выключена и скрыта */
  enabled: boolean;
  percentage: number;
  killed: boolean;
}

export const FLAG_CATALOG: readonly CatalogFlag[] = [
  {
    key: 'checkout.new_flow',
    description:
      'Мгновенный чекаут POST /bookings/checkout: бронь + оплата одним ' +
      'вызовом (вне раскатки маршрут скрыт, 403 featureDisabled)',
    enabled: true,
    percentage: 0,
    killed: false,
  },
  {
    key: 'booking.qr_v2',
    description:
      'Билеты QR-v2: новый формат кода на месте (демо постепенного включения)',
    enabled: true,
    percentage: 0,
    killed: false,
  },
  {
    key: 'demo.audience',
    description:
      'Демо-«зрители» живой карты мест: тумблер для показательного kill-switch',
    enabled: true,
    percentage: 100,
    killed: false,
  },
];
