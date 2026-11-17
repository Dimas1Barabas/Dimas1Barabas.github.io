import { BarCategory, BarItem } from './bar-item.entity';

/**
 * Стартовый каталог кинобара — сеет BarService.onModuleInit в пустую
 * таблицу (как фильмы). Остатки нарочно разные, включая дефицит:
 * «Вода 0,5 л» со stock 3 — дефицит виден на витрине бейджем «осталось N»
 * и проверяется тестами гонки за последнюю порцию.
 */
export const BAR_CATALOG: Array<
  Pick<BarItem, 'slug' | 'name' | 'category' | 'priceRub' | 'stock'>
> = [
  { slug: 'popcorn-salted', name: 'Попкорн солёный', category: 'popcorn', priceRub: 320, stock: 40 },
  { slug: 'popcorn-caramel', name: 'Попкорн карамельный', category: 'popcorn', priceRub: 340, stock: 35 },
  { slug: 'popcorn-cheese', name: 'Попкорн сырный', category: 'popcorn', priceRub: 350, stock: 20 },
  { slug: 'cola-05', name: 'Кола 0,5 л', category: 'drinks', priceRub: 220, stock: 30 },
  { slug: 'cola-1', name: 'Кола 1 л', category: 'drinks', priceRub: 330, stock: 12 },
  { slug: 'water-sparkling', name: 'Вода газированная 0,5 л', category: 'drinks', priceRub: 150, stock: 3 },
  { slug: 'nachos-cheese', name: 'Начос с сырным соусом', category: 'snacks', priceRub: 380, stock: 18 },
  { slug: 'combo-classic', name: 'Комбо: попкорн солёный + кола 0,5', category: 'combo', priceRub: 490, stock: 25 },
  { slug: 'combo-family', name: 'Комбо семейное: 2 попкорна + 2 колы', category: 'combo', priceRub: 890, stock: 8 },
];

/** порядок категорий на витрине: попкорн → напитки → снеки → комбо */
export const CATEGORY_ORDER: readonly BarCategory[] = [
  'popcorn',
  'drinks',
  'snacks',
  'combo',
];

export function categoryRank(category: BarCategory): number {
  const rank = CATEGORY_ORDER.indexOf(category);
  return rank === -1 ? CATEGORY_ORDER.length : rank;
}
