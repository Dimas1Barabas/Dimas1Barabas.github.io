import { expect, test, type Page } from '@playwright/test';

/**
 * Гифт-сертификаты в демо-режиме против vite preview: движок зеркалит
 * GiftsService и pay-транзакцию API. Видимый контур: покупка → код
 * крупно → активация → карта в таблице → бронь с гифт-кодом → вердикт
 * CONFIRMED (тестовая сборка детерминирована). Место берём заведомо
 * свободное из карты движка (window.__cineDemo) — как booking-cycle.
 */

/** первые `count` свободных мест ближайшего будущего сеанса фильма */
async function freeSeatsOf(
  page: Page,
  title: string,
  count: number,
): Promise<void> {
  const seats = await page.evaluate(
    ({ movieTitle, n }) => {
      const engine = (
        window as unknown as {
          __cineDemo: {
            movies: () => {
              data: {
                title: string;
                sessions: { id: string; startsAt: string }[];
              }[];
            };
            seatMap: (id: string) => { occupied: string[] };
          };
        }
      ).__cineDemo;
      const movie = engine.movies().data.find((m) => m.title === movieTitle);
      const upcoming = movie?.sessions.find(
        (s) => Date.parse(s.startsAt) > Date.now(),
      );
      if (!upcoming) throw new Error(`нет будущих сеансов у «${movieTitle}»`);
      const occupied = new Set(engine.seatMap(upcoming.id).occupied);
      const free: string[] = [];
      for (let row = 1; row <= 8 && free.length < n; row += 1) {
        for (let seat = 1; seat <= 10 && free.length < n; seat += 1) {
          const code = `${row}-${seat}`;
          if (!occupied.has(code)) free.push(code);
        }
      }
      return free;
    },
    { movieTitle: title, n: count },
  );
  if (seats.length < count) throw new Error('свободных мест нет');
  for (const seat of seats) {
    const [row, num] = seat.split('-');
    await page
      .locator(`.hall__seat[aria-label="Ряд ${row}, место ${num}"]`)
      .click();
  }
}

test.describe('гифт-сертификаты (демо)', () => {
  test('купить → активировать → списать в оплате брони', async ({ page }) => {
    await page.goto('/#/gifts');

    // сид-карта в таблице и доступный остаток
    await expect(page.getByTestId('gift-card-GIFT-DEM0CA11')).toBeVisible();

    // покупка: пресет 1000 → свежий код крупно
    await page.getByTestId('gift-nominal-1000').click();
    await page.getByTestId('gift-buy').click();
    const freshCode = (await page.getByTestId('gift-fresh-code').textContent()) ?? '';
    expect(freshCode).toMatch(/^GIFT-[0-9A-HJKMNP-TV-Z]{8}$/);

    // активация своего кода тем же полем (регистр неважен)
    await page.getByTestId('gift-activate-input').fill(freshCode.toLowerCase());
    await page.getByTestId('gift-activate').click();
    await expect(page.getByTestId('gift-activated-ok')).toContainText(freshCode);

    // карта появилась в «моих» с полным номиналом
    await expect(
      page.locator(`[data-testid="gift-card-${freshCode}"]`),
    ).toContainText('1 000');

    // бронь на 1 место → экран оплаты → гифт-код списывает хвост чека.
    // SPA-навигация по ссылке в шапке (не goto): движок живёт в памяти
    // страницы — перезагрузка стёрла бы купленную карту
    await page.getByRole('link', { name: 'Сеансы' }).click();
    await page
      .locator('.movie-card', { hasText: 'Госпожа Кэш' })
      .getByRole('button', { name: 'Забронировать' })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.getByPlaceholder('Например, Дмитрий').fill('Плейрайт Подарков');
    await freeSeatsOf(page, 'Госпожа Кэш', 1);
    await dialog.getByRole('button', { name: 'Забронировать' }).click();
    await expect(page).toHaveURL(/#\/pay\//);

    // поле гифт-кода: своя карта превращается в чип со списанием
    await page.getByTestId('gift-input').fill(freshCode);
    await expect(page.getByTestId('gift-applied')).toContainText(freshCode);
    await expect(page.getByTestId('gift-applied')).toContainText('−');

    // оплата картой: чек одного места меньше номинала — закрывается целиком
    await page.getByRole('button', { name: /^Оплатить/ }).click();
    await expect(page.getByText('Проводим платёж')).toBeVisible();
    await expect(page.getByText('Оплата прошла — билеты ваши!')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('опечатка в подаренном коде — подсказка от движка, как от API', async ({
    page,
  }) => {
    await page.goto('/#/gifts');

    await page.getByTestId('gift-activate-input').fill('GIFT-NOPE1234');
    await page.getByTestId('gift-activate').click();

    await expect(page.getByTestId('gift-activate-error')).toContainText(
      'не найден',
    );
  });
});
