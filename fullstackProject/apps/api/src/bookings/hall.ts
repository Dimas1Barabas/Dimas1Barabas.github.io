/**
 * Геометрия зала: в демо-кинотеатре один зал на все сеансы.
 * Место адресуется кодом «ряд-место», например «5-7» — ряд 5, место 7.
 */
export const HALL_ROWS = 8;
export const HALL_SEATS_PER_ROW = 10;
export const HALL_CAPACITY = HALL_ROWS * HALL_SEATS_PER_ROW;

/** Код места в формате «ряд-место» */
export const SEAT_CODE_RE = /^\d+-\d+$/;

/** Место существует, если ряд и номер внутри зала */
export function isValidSeat(seat: string): boolean {
  if (!SEAT_CODE_RE.test(seat)) return false;
  const [row, num] = seat.split('-').map(Number);
  return row >= 1 && row <= HALL_ROWS && num >= 1 && num <= HALL_SEATS_PER_ROW;
}

/** Сортировка мест: по ряду, затем по номеру места («2-9» < «2-10» < «3-1») */
export function compareSeats(a: string, b: string): number {
  const [ar, an] = a.split('-').map(Number);
  const [br, bn] = b.split('-').map(Number);
  return ar - br || an - bn;
}

/** Ответ GET /api/movies/:id/seats — всё, что нужно для карты зала */
export interface SeatMapDto {
  movieId: string;
  layout: { rows: number; seatsPerRow: number };
  /** занятые места (PENDING держит место, CONFIRMED — тем более) */
  occupied: string[];
  free: number;
}
