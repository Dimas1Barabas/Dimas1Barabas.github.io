import { expect, test, type Page } from '@playwright/test';

/**
 * Антифрод «Детектив» в демо-режиме против vite preview: витрина решений
 * в админке и решения человека. Движок зеркалит правила Go-домена —
 * разгон velocity и чекаут делаем через window.__cineDemo (как
 * booking-cycle берёт места), проверяем видимый контур админки.
 */

interface EngineWindow {
  __cineDemo: {
    movies: () => {
      data: {
        title: string;
        sessions: { id: string; startsAt: string }[];
      }[];
    };
    seatMap: (id: string) => { occupied: string[] };
    create: (payload: { sessionId: string; seats: string[] }) => { id: string };
    checkout: (payload: { sessionId: string; seats: string[] }) => unknown;
  };
}

/** первый будущий сеанс афиши */
async function firstSession(page: Page): Promise<string> {
  return page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__cineDemo;
    const movie = engine.movies().data[0];
    const upcoming =
      movie.sessions.find((s) => Date.parse(s.startsAt) > Date.now()) ??
      movie.sessions[0];
    return upcoming.id;
  });
}

/** свободные места сеанса из живой карты движка */
async function freeSeats(
  page: Page,
  sessionId: string,
  count: number,
): Promise<string[]> {
  const seats = await page.evaluate(
    ({ id, n }) => {
      const engine = (window as unknown as EngineWindow).__cineDemo;
      const occupied = new Set(engine.seatMap(id).occupied);
      const free: string[] = [];
      for (let row = 1; row <= 8 && free.length < n; row += 1) {
        for (let seat = 1; seat <= 10 && free.length < n; seat += 1) {
          const code = `${row}-${seat}`;
          if (!occupied.has(code)) free.push(code);
        }
      }
      return free;
    },
    { id: sessionId, n: count },
  );
  if (seats.length < count) throw new Error('свободных мест нет');
  return seats;
}

/** разгон velocity: count односедельных броней до чекаута */
async function rampUp(page: Page, sessionId: string, count: number): Promise<void> {
  await page.evaluate(
    ({ id, n }) => {
      const engine = (window as unknown as EngineWindow).__cineDemo;
      for (let i = 0; i < n; i += 1) {
        const occupied = new Set(engine.seatMap(id).occupied);
        const free: string[] = [];
        for (let row = 1; row <= 8 && free.length < 1; row += 1) {
          for (let seat = 1; seat <= 10 && free.length < 1; seat += 1) {
            const code = `${row}-${seat}`;
            if (!occupied.has(code)) free.push(code);
          }
        }
        engine.create({ sessionId: id, seats: free });
      }
    },
    { id: sessionId, n: count },
  );
}

test.describe('антифрод «Детектив» (демо)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/admin');
    await expect(page.getByText('Детектив — антифрод')).toBeVisible();
  });

  test('review-бронь: очередь витрины, approve запускает оплату', async ({ page }) => {
    const sessionId = await firstSession(page);
    await rampUp(page, sessionId, 5); // срез увидит 5: newAccount+velocity = 55
    const seat = (await freeSeats(page, sessionId, 1))[0];
    const bookingId = await page.evaluate(
      ({ id, seatCode }) => {
        const engine = (window as unknown as EngineWindow).__cineDemo;
        const booking = engine.checkout({
          sessionId: id,
          seats: [seatCode],
        }) as { id: string; status: string; fraudHold: boolean };
        return booking.id;
      },
      { id: sessionId, seatCode: seat },
    );

    // строка очереди: скор, вердикт и коды правил
    const row = page.getByTestId(`fraud-row-${bookingId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('ревью');
    await expect(row).toContainText('на ревью');
    await expect(row).toContainText('55');
    await expect(row).toContainText('newAccount, velocity');

    // решение человека — одобрить: строка уходит из очереди; снимаем
    // фильтр — решение видно в истории со статусом «одобрено»
    await page.getByTestId(`fraud-approve-${bookingId}`).click();
    await expect(
      page.getByTestId(`fraud-approve-${bookingId}`),
    ).toHaveCount(0);
    await page.getByText('только очередь ревью').click();
    await expect(page.getByTestId(`fraud-row-${bookingId}`)).toContainText(
      'одобрено',
    );
  });

  test('reject: бронь гасится и место возвращается в продажу', async ({ page }) => {
    const sessionId = await firstSession(page);
    await rampUp(page, sessionId, 5);
    const seat = (await freeSeats(page, sessionId, 1))[0];
    const { bookingId } = await page.evaluate(
      ({ id, seatCode }) => {
        const engine = (window as unknown as EngineWindow).__cineDemo;
        const booking = engine.checkout({
          sessionId: id,
          seats: [seatCode],
        }) as { id: string };
        return { bookingId: booking.id };
      },
      { id: sessionId, seatCode: seat },
    );

    await page.getByTestId(`fraud-reject-${bookingId}`).click();
    // строка покинула очередь; в истории — «отклонено»
    await page.getByText('только очередь ревью').click();
    await expect(page.getByTestId(`fraud-row-${bookingId}`)).toContainText(
      'отклонено',
    );

    // место снова в продаже — живая карта движка
    const freeAgain = await page.evaluate(
      ({ id, seatCode }) => {
        const engine = (window as unknown as EngineWindow).__cineDemo;
        return !engine.seatMap(id).occupied.includes(seatCode);
      },
      { id: sessionId, seatCode: seat },
    );
    expect(freeAgain).toBe(true);
  });

  test('block: конвейер броней — отказ с причинами, брони нет', async ({ page }) => {
    const sessionId = await firstSession(page);
    await rampUp(page, sessionId, 10); // velocityHigh: срез увидит 10
    const seats = await freeSeats(page, sessionId, 6); // manySeats

    const refusal = await page.evaluate(
      ({ id, seatCodes }) => {
        const engine = (window as unknown as EngineWindow).__cineDemo;
        try {
          engine.checkout({ sessionId: id, seats: seatCodes });
          return { code: null };
        } catch (err) {
          return JSON.parse((err as { body: string }).body) as {
            code: string | null;
            score?: number;
            reasons?: string[];
          };
        }
      },
      { id: sessionId, seatCodes: seats },
    );

    expect(refusal.code).toBe('fraudBlocked');
    expect(refusal.score).toBe(75);
    expect(refusal.reasons).toEqual([
      'newAccount',
      'velocityHigh',
      'manySeats',
    ]);

    // авто-вердикт в витрине: снять фильтр «только очередь» — строка
    // block-решения видна (модификатор ряда по вердикту)
    await page.getByText('только очередь ревью').click();
    await expect(page.locator('.admin-fraud__row--block').first()).toBeVisible();
  });
});
