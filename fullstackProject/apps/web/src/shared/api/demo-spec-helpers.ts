import { demoEngine } from '@/shared/api/demo-engine';
import type { SeatMap } from '@/shared/api/types';

/** Хелперы доменных спек демо-движка (demo-*.spec.ts) */

/** фильм без сид-отзывов — чистая база для тестов отзыва гостя */
export const CLEAN_MOVIE = 'demo-cache-lady';

/** первое свободное место карты — чтобы тесты не зависели от посева */
export function freeSeat(map: SeatMap): string {
  for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) return code;
    }
  }
  throw new Error('зал заполнен');
}

export function firstFreeSeats(map: SeatMap, count: number): string[] {
  const seats: string[] = [];
  outer: for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) {
        seats.push(code);
        if (seats.length === count) break outer;
      }
    }
  }
  return seats;
}

/** цена места сеанса «до брони» — квот Тарификатора, как в live */
export function seatPriceOf(sessionId: string): number {
  return demoEngine.quote(sessionId).priceRub;
}

/** первый фильм афиши и его ближайший будущий сеанс — рабочая пара
 *  для большинства тестов (ночной прогон не должен упираться в «сегодня,
 *  19:00» — сеанс уже начался, waitlist закрыт, цена посчитана иначе) */
export function firstSession() {
  const movie = demoEngine.movies().data[0];
  const session =
    movie.sessions.find((s) => Date.parse(s.startsAt) > Date.now()) ??
    movie.sessions[0];
  if (!session) throw new Error('в демо-фикстуре нет сеансов');
  return { movie, session };
}
