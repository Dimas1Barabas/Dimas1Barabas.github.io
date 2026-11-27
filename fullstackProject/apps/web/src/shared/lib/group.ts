import { isValidSeat } from '@/shared/lib/hall';

/**
 * Веб-зеркало домена групп «Идём вместе» (лекало pricing/promo-зеркал):
 * палитра участников, коды-приглашения, готовность всех и конфликты
 * выборов — то же поведение, что apps/api/src/groups/group.logic.ts.
 * Здесь живёт демо-движок; live-страница цвета и статусы берёт с сервера.
 */

/** палитра участников: цвет = индекс входа, различима на тёмной теме */
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

export const MAX_PARTICIPANTS = 8;
export const MAX_SEATS_PER_PARTICIPANT = 8;
export const GROUP_CODE_LENGTH = 6;
/** алфавит без похожих (0/O, 1/I/L) — код читается с ссылки глазами */
const GROUP_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function colorFor(colorIndex: number): string {
  return PARTICIPANT_COLORS[colorIndex % PARTICIPANT_COLORS.length]!;
}

export function generateGroupCode(): string {
  let code = '';
  for (let i = 0; i < GROUP_CODE_LENGTH; i += 1) {
    code += GROUP_CODE_ALPHABET[Math.floor(Math.random() * GROUP_CODE_ALPHABET.length)];
  }
  return code;
}

/** нормализация имени — те же границы, что customerName брони */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 60) return null;
  return name;
}

export function isValidSelection(seats: string[]): boolean {
  if (seats.length > MAX_SEATS_PER_PARTICIPANT) return false;
  const unique = new Set(seats);
  if (unique.size !== seats.length) return false;
  return seats.every((seat) => isValidSeat(seat));
}

/** пересечения выборов: место → id участников */
export function selectionConflicts(
  participants: readonly { id: string; seats: string[] }[],
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

/** готовы все: непусто, каждый готов с выбором */
export function everyoneReady(
  participants: readonly { ready: boolean; seats: string[] }[],
): boolean {
  if (participants.length === 0) return false;
  return participants.every((p) => p.ready && p.seats.length > 0);
}
