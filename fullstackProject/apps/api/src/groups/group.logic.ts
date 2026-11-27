import { randomInt } from 'node:crypto';
import { isValidSeat } from '../bookings/hall';

/**
 * Домен «Идём вместе» (этап 40): группа зрителей выбирает места вместе.
 *
 * Группа — эфемерный координационный слой поверх обычного флоу брони:
 * участники видят цветные пометки выборов друг друга на общей live-карте,
 * жмут «Готов», когда готовы все — выборы фиксируются, и каждый бронирует
 * свои места сам (свой платёж, свои билеты). Таймаут без активности —
 * группа распадается. Хранения в БД нет: как комнаты WS-гейтвея,
 * группа живёт в памяти API.
 */

/** Код-приглашение: 6 символов без похожих (0/O, 1/I/L) — в ссылке /#/join/<код> */
export const GROUP_CODE_LENGTH = 6;
export const GROUP_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Верхняя граница группы: столько различимых цветов в палитре */
export const MAX_PARTICIPANTS = 8;

/** Максимум мест у одного участника — равен лимиту мест одной брони */
export const MAX_SEATS_PER_PARTICIPANT = 8;

/** Имя участника — те же границы, что customerName брони */
export const PARTICIPANT_NAME_MIN = 2;
export const PARTICIPANT_NAME_MAX = 60;

/**
 * Палитра участников: цвет = порядковый индекс входа в группу.
 * Подобраны различимыми на тёмной теме (основной темы витрины).
 */
export const PARTICIPANT_COLORS: readonly string[] = Object.freeze([
  '#22d3ee', // cyan
  '#f472b6', // pink
  '#a3e635', // lime
  '#fbbf24', // amber
  '#818cf8', // indigo
  '#34d399', // emerald
  '#f87171', // red
  '#e879f9', // fuchsia
]);

/** Жизненный цикл группы: выбор → всё готово (фиксация) → распад */
export type GroupStatus = 'picking' | 'fixed' | 'disbanded';

/** Участник группы: личность переживает реконнект WS по id */
export interface Participant {
  id: string;
  name: string;
  /** индекс в PARTICIPANT_COLORS — цвет пометок на карте */
  colorIndex: number;
  /** выбранные места (коды «ряд-место»), замена целиком */
  seats: string[];
  ready: boolean;
  /** участник забронировал свои места после фиксации */
  booked: boolean;
  joinedAt: number;
}

/** Код-приглашение из криптослучайного источника (инжектится для тестов) */
export function generateGroupCode(
  rand: (maxExclusive: number) => number = (max) => randomInt(max),
): string {
  let code = '';
  for (let i = 0; i < GROUP_CODE_LENGTH; i += 1) {
    code += GROUP_CODE_ALPHABET[rand(GROUP_CODE_ALPHABET.length)];
  }
  return code;
}

/** Цвет участника по индексу входа (по кругу сверх палитры не заходим — лимит) */
export function colorFor(colorIndex: number): string {
  return PARTICIPANT_COLORS[colorIndex % PARTICIPANT_COLORS.length]!;
}

/**
 * Нормализация имени: trim, схлопывание пробелов, границы длины.
 * Невалидное (короче 2 / длиннее 60 / пустое) → null.
 */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < PARTICIPANT_NAME_MIN) return null;
  if (name.length > PARTICIPANT_NAME_MAX) return null;
  return name;
}

/** Выбор участника валиден: без дублей, в границах зала, не длиннее лимита */
export function isValidSelection(seats: string[]): boolean {
  if (seats.length > MAX_SEATS_PER_PARTICIPANT) return false;
  const unique = new Set(seats);
  if (unique.size !== seats.length) return false;
  return seats.every((seat) => isValidSeat(seat));
}

/**
 * Пересечения выборов: место → id участников, выбравших его.
 * Конфликт не запрещает выбирать (пометки видны всем), но блокирует
 * фиксацию — снимается тем, кто уступит место.
 */
export function selectionConflicts(
  participants: readonly Pick<Participant, 'id' | 'seats'>[],
): Map<string, string[]> {
  const bySeat = new Map<string, string[]>();
  for (const p of participants) {
    for (const seat of p.seats) {
      const holders = bySeat.get(seat) ?? [];
      holders.push(p.id);
      bySeat.set(seat, holders);
    }
  }
  for (const [seat, holders] of bySeat) {
    if (holders.length < 2) bySeat.delete(seat);
  }
  return bySeat;
}

/**
 * Готовы все: в группе кто-то есть и каждый подтвердил готовность
 * с непустым выбором (пустой выбор нечего бронировать — «Готов»
 * с пустым списком отклоняется сервисом).
 */
export function everyoneReady(
  participants: readonly Pick<Participant, 'ready' | 'seats'>[],
): boolean {
  if (participants.length === 0) return false;
  return participants.every((p) => p.ready && p.seats.length > 0);
}
