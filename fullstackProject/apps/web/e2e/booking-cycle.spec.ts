import { expect, test, type Page } from '@playwright/test';

/**
 * Полный цикл брони в демо-режиме через настоящий браузер: витрина →
 * модалка выбора мест → экран оплаты (промокод + бонусы) → вердикт
 * «воркера» → QR-билеты; отдельно — отказ от оплаты и возврат
 * подтверждённой брони с табло «Бронирования».
 *
 * Данные читаем из движка (window.__cineDemo, тестовая сборка):
 * места берём заведомо свободные — сиды «других зрителей» не знаем.
 */

/** первый сеанс фильма — как его выбирает модалка по умолчанию */
async function firstSessionId(page: Page, title: string): Promise<string> {
  return page.evaluate((movieTitle) => {
    const engine = (
      window as unknown as {
        __cineDemo: { movies: () => { data: { title: string; sessions: { id: string }[] }[] } };
      }
    ).__cineDemo;
    const movie = engine.movies().data.find((m) => m.title === movieTitle);
    if (!movie?.sessions.length) throw new Error(`нет сеансов у «${movieTitle}»`);
    return movie.sessions[0].id;
  }, title);
}

/** первые `count` свободных мест сеанса по карте движка */
async function freeSeats(
  page: Page,
  sessionId: string,
  count: number,
): Promise<string[]> {
  return page.evaluate(
    ({ sid, n }) => {
      const engine = (
        window as unknown as {
          __cineDemo: { seatMap: (id: string) => { occupied: string[] } };
        }
      ).__cineDemo;
      const occupied = new Set(engine.seatMap(sid).occupied);
      const free: string[] = [];
      for (let row = 1; row <= 8 && free.length < n; row += 1) {
        for (let seat = 1; seat <= 10 && free.length < n; seat += 1) {
          const code = `${row}-${seat}`;
          if (!occupied.has(code)) free.push(code);
        }
      }
      return free;
    },
    { sid: sessionId, n: count },
  );
}

/** бронь через UI: карточка → модалка → имя → места → «Забронировать» */
async function bookViaUi(
  page: Page,
  title: string,
  seatCount: number,
): Promise<string[]> {
  const sessionId = await firstSessionId(page, title);
  const seats = await freeSeats(page, sessionId, seatCount);
  await page
    .locator('.movie-card', { hasText: title })
    .getByRole('button', { name: 'Забронировать' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(title);
  await page.getByPlaceholder('Например, Дмитрий').fill('Плейрайт Оттестовал');
  for (const seat of seats) {
    const [row, num] = seat.split('-');
    await page
      .locator(`.hall__seat[aria-label="Ряд ${row}, место ${num}"]`)
      .click();
  }
  await dialog.getByRole('button', { name: 'Забронировать' }).click();
  await expect(page).toHaveURL(/#\/pay\//);
  return seats;
}

test.describe('полный цикл брони (демо)', () => {
  test('места → промокод + бонусы → вердикт CONFIRMED → QR-билеты', async ({
    page,
  }) => {
    const seats = await (async () => {
      await page.goto('/');
      return bookViaUi(page, 'Госпожа Кэш', 2);
    })();

    // экран оплаты: бронь на месте, сумма и таймер окна видны
    await expect(page.getByRole('heading', { name: 'Оплата брони' })).toBeVisible();
    await expect(page.locator('.booking-row__title')).toHaveText('Госпожа Кэш');
    await expect(page.getByText('оплата в течение')).toBeVisible();

    // промокод CINE10 (−10%): чип применён, база зачёркнута
    await page.getByPlaceholder('Промокод, например CINE10').fill('CINE10');
    await page.getByRole('button', { name: 'Применить' }).click();
    await expect(page.locator('.promo-applied__code')).toHaveText('🎟️ CINE10');
    await expect(page.locator('.promo-applied__base')).toBeVisible();

    // бонусы гостя демо (сид-баланс 350): чекбокс подставляет максимум —
    // не больше половины чека после промокода
    await page.getByLabel(/Списать бонусы/).check();
    const bonusInput = page.locator('.pay-bonus__input');
    await expect(bonusInput).toBeVisible();
    const spend = Number(await bonusInput.inputValue());
    expect(spend).toBeGreaterThan(0);

    // оплата: PENDING → детерминированный вердикт CONFIRMED
    await page.getByRole('button', { name: /^Оплатить/ }).click();
    await expect(page.getByText('Проводим платёж')).toBeVisible();
    await expect(page.getByText('Оплата прошла — билеты ваши!')).toBeVisible({
      timeout: 10_000,
    });

    // QR-билеты: по карточке на место, номер TK-, полноэкранный QR по Esc
    await page.getByRole('link', { name: 'Показать QR-билеты' }).click();
    await expect(page.getByRole('heading', { name: 'Билеты на вход' })).toBeVisible();
    const tickets = page.locator('.ticket-card');
    await expect(tickets).toHaveCount(seats.length);
    await expect(tickets.first().locator('.ticket-card__no')).toContainText('TK-');
    await tickets.first().locator('.ticket-card__qr').click();
    await expect(page.locator('.ticket-fullscreen')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ticket-fullscreen')).toBeHidden();
  });

  test('отмена неоплаченной брони — мгновенный CANCELLED без воркера', async ({
    page,
  }) => {
    await page.goto('/');
    await bookViaUi(page, 'Последний дебаг', 1);

    await page.getByRole('button', { name: 'Отменить бронь' }).click();
    await expect(page.getByText('Бронь отменена.')).toBeVisible();
  });

  test('возврат подтверждённой брони с табло — сага CANCELLING → CANCELLED', async ({
    page,
  }) => {
    await page.goto('/');
    const seats = await bookViaUi(page, 'Сорок девятый поток', 1);

    await page.getByRole('button', { name: /^Оплатить/ }).click();
    await expect(page.getByText('Оплата прошла — билеты ваши!')).toBeVisible({
      timeout: 10_000,
    });

    // табло «Бронирования»: своя строка узнаётся по месту (сиды не знают его)
    await page.getByRole('link', { name: 'Бронирования' }).click();
    const row = page
      .locator('.booking-row', { hasText: 'Сорок девятый поток' })
      .filter({ hasText: seats[0] });
    await expect(row.locator('.status-badge')).toHaveText('✅ подтверждена');

    // отмена CONFIRMED — refund-сага детерминированно завершается
    await row.getByRole('button', { name: 'Отменить' }).click();
    await expect(row.locator('.status-badge')).toHaveText('🚫 отменена', {
      timeout: 10_000,
    });
  });
});
