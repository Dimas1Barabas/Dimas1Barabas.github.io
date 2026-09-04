/**
 * Геометрия зала демо-кинотеатра — зеркало apps/api/src/bookings/hall.ts.
 * Место адресуется кодом «ряд-место», например «5-7».
 */
export const HALL_ROWS = 8;
export const HALL_SEATS_PER_ROW = 10;
export const HALL_CAPACITY = HALL_ROWS * HALL_SEATS_PER_ROW;

export function seatCode(row: number, num: number): string {
  return `${row}-${num}`;
}

export function isValidSeat(seat: string): boolean {
  const m = /^(\d+)-(\d+)$/.exec(seat);
  if (!m) return false;
  const [, row, num] = m;
  return (
    Number(row) >= 1 &&
    Number(row) <= HALL_ROWS &&
    Number(num) >= 1 &&
    Number(num) <= HALL_SEATS_PER_ROW
  );
}

/** сортировка по ряду, затем по месту («2-9» < «2-10» < «3-1») */
export function compareSeats(a: string, b: string): number {
  const [ar, an] = a.split('-').map(Number);
  const [br, bn] = b.split('-').map(Number);
  return ar - br || an - bn;
}

/** все коды зала: ["1-1", "1-2", … "8-10"] */
export function allSeatCodes(): string[] {
  const codes: string[] = [];
  for (let row = 1; row <= HALL_ROWS; row++) {
    for (let num = 1; num <= HALL_SEATS_PER_ROW; num++) {
      codes.push(seatCode(row, num));
    }
  }
  return codes;
}
