import { expect, test, type Page } from '@playwright/test';

/**
 * Живая карта мест в демо: пока модалка открыта, «другой зритель» занимает
 * место — карта серееет без перезагрузки (onChange движка, как SSE в live).
 * В тестовой сборке таймер зрителей молчит: тест сам зовёт
 * simulateOtherViewer через window.__cineDemo и читает, что тот занял.
 * evaluate не переносит замыкания — доступ к движку инлайнится в каждом.
 */

type Engine = {
  movies: () => { data: { title: string; sessions: { id: string; startsAt: string }[] }[] };
  seatMap: (id: string) => { occupied: string[] };
  simulateOtherViewer: (id: string, avoid: string[]) => 'taken' | 'released' | 'none';
};

/** ближайший будущий сеанс фильма — дефолт модалки; title можно частично */
async function upcomingSession(page: Page, title: string): Promise<string> {
  return page.evaluate((movieTitle) => {
    const engine = (window as unknown as { __cineDemo: Engine }).__cineDemo;
    const movie = engine.movies().data.find((m) => m.title.includes(movieTitle));
    const upcoming = movie?.sessions.find(
      (s) => Date.parse(s.startsAt) > Date.now(),
    );
    if (!upcoming) throw new Error(`нет будущих сеансов у «${movieTitle}»`);
    return upcoming.id;
  }, title);
}

/** занятость сеанса прямо сейчас */
async function occupied(page: Page, sessionId: string): Promise<string[]> {
  return page.evaluate(
    (sid) => (window as unknown as { __cineDemo: Engine }).__cineDemo.seatMap(sid).occupied,
    sessionId,
  );
}

/** кнопка места в карте по коду «ряд-место» */
function seatButton(page: Page, seat: string) {
  const [row, num] = seat.split('-');
  return page.locator(`.hall__seat[aria-label="Ряд ${row}, место ${num}"]`);
}

async function openMovie(page: Page, title: string) {
  await page
    .locator('.movie-card', { hasText: title })
    .getByRole('button', { name: 'Забронировать' })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(title);
  await expect(dialog.locator('.hall__seat')).toHaveCount(80);
  return dialog;
}

test.describe('живая карта мест (демо)', () => {
  test('чужая покупка серееет место мгновенно, выбор не трогает', async ({
    page,
  }) => {
    await page.goto('/');
    const sessionId = await upcomingSession(page, 'Млечный Путь');
    const before = new Set(await occupied(page, sessionId));

    const dialog = await openMovie(page, 'Млечный Путь');

    // своё место — первое свободное (before — занятые!): зритель не должен
    // его занимать
    const mine = ['1-1', '1-2', '1-3', '1-4'].find((code) => !before.has(code));
    if (!mine) throw new Error('первые места ряда заняты — расширь кандидатов');
    await seatButton(page, mine).click();
    await expect(
      dialog.getByRole('button', { name: `Снять место ${mine}` }),
    ).toBeVisible();

    // зритель занимает любое место, кроме нашего (avoid — наш выбор)
    const verdict = await page.evaluate(
      ({ sid, avoid }) =>
        (window as unknown as { __cineDemo: Engine }).__cineDemo.simulateOtherViewer(
          sid,
          avoid,
        ),
      { sid: sessionId, avoid: [mine] },
    );
    expect(verdict).toBe('taken');
    const [freshlyTaken] = (await occupied(page, sessionId)).filter(
      (seat) => !before.has(seat),
    );

    // карта обновилась без перезагрузки: место занято и заблокировано
    await expect(seatButton(page, freshlyTaken)).toBeDisabled();
    await expect(seatButton(page, freshlyTaken)).toHaveClass(/hall__seat--taken/);

    // наш выбор уцелел — avoid работает
    await expect(
      dialog.getByRole('button', { name: `Снять место ${mine}` }),
    ).toBeVisible();
  });

  test('место заняли прямо под выбором — выпадает с подсказкой', async ({
    page,
  }) => {
    await page.goto('/');
    const sessionId = await upcomingSession(page, 'Тайна старого репозитория');
    const dialog = await openMovie(page, 'Тайна старого репозитория');

    // выбираем место, затем «зритель» занимает именно его: avoid = все
    // свободные, кроме выбранного — движку остаётся один вариант
    const takenBefore = await occupied(page, sessionId);
    const allSeats = await page.evaluate(() => {
      const codes: string[] = [];
      for (let row = 1; row <= 8; row += 1) {
        for (let seat = 1; seat <= 10; seat += 1) codes.push(`${row}-${seat}`);
      }
      return codes;
    });
    const freeSeats = allSeats.filter((code) => !takenBefore.includes(code));
    const mine = freeSeats[0];
    await seatButton(page, mine).click();
    await expect(
      dialog.getByRole('button', { name: `Снять место ${mine}` }),
    ).toBeVisible();

    const verdict = await page.evaluate(
      ({ sid, avoid }) =>
        (window as unknown as { __cineDemo: Engine }).__cineDemo.simulateOtherViewer(
          sid,
          avoid,
        ),
      { sid: sessionId, avoid: freeSeats.filter((seat) => seat !== mine) },
    );
    expect(verdict).toBe('taken');

    // место выпало из выбора, ошибка объяснила что случилось
    await expect(
      dialog.getByRole('button', { name: `Снять место ${mine}` }),
    ).toBeHidden();
    await expect(dialog.locator('.modal__error')).toContainText(
      `Место ${mine} только что заняли`,
    );
    await expect(seatButton(page, mine)).toBeDisabled();
  });
});
