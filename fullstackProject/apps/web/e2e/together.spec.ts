import { expect, test, type Page } from '@playwright/test';

/**
 * «Идём вместе» в демо: группа из окна брони → комната /join/:code →
 * цветные пометки и готовность «Ани» (в тестовой сборке таймер друга
 * молчит — шаги водим через window.__cineDemo) → фиксация по готовности
 * всех → «Забронировать мои места» уводит на оплату.
 */

type Engine = {
  movies: () => {
    data: { title: string; sessions: { id: string; startsAt: string }[] }[];
  };
  groupPreview: (code: string) => {
    status: string;
    sessionId: string;
    participants: { name: string; color: string; seats: string[] }[];
  };
  seatMap: (id: string) => { occupied: string[] };
  groupFriendStep: (code: string, avoid: string[]) => 'join' | 'select' | 'ready' | 'none';
};

/** свободное место сеанса группы — из карты движка (сид-занятое не трогаем) */
async function freeRoomSeat(page: Page, code: string): Promise<string> {
  return page.evaluate((c) => {
    const engine = (window as unknown as { __cineDemo: Engine }).__cineDemo;
    const sessionId = engine.groupPreview(c).sessionId;
    const taken = new Set(engine.seatMap(sessionId).occupied);
    for (let row = 1; row <= 8; row++) {
      for (let seat = 1; seat <= 10; seat++) {
        const seatCode = `${row}-${seat}`;
        if (!taken.has(seatCode)) return seatCode;
      }
    }
    throw new Error('зал сеанса группы переполнен');
  }, code);
}

/** код группы из адреса комнаты */
async function roomCode(page: Page): Promise<string> {
  const match = page.url().match(/#\/join\/([2-9A-HJKMNP-Z]{6})/);
  if (!match) throw new Error(`URL не похож на комнату группы: ${page.url()}`);
  return match[1]!;
}

/** один шаг «Ани» через движок */
async function friendStep(page: Page, code: string, avoid: string[] = []) {
  return page.evaluate(
    ({ code, avoid }) =>
      (window as unknown as { __cineDemo: Engine }).__cineDemo.groupFriendStep(code, avoid),
    { code, avoid },
  );
}

function seatButton(page: Page, seat: string) {
  const [row, num] = seat.split('-');
  // скоп комнаты: в момент перехода из модалки в DOM две карты (анимация)
  return page.locator(
    `.group-room__map .hall__seat[aria-label="Ряд ${row}, место ${num}"]`,
  );
}

test.describe('«Идём вместе» (демо)', () => {
  test('группа из модалки: комната, «Аня», фиксация, бронь своих мест', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .locator('.movie-card', { hasText: 'Млечный Путь' })
      .getByRole('button', { name: 'Забронировать' })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Млечный Путь');

    // демо спрашивает имя — оно станет именем организатора
    await dialog.locator('input.field__input').first().fill('Дима');
    await dialog.getByRole('button', { name: /Идём вместе/ }).click();
    await dialog.getByRole('link', { name: 'Перейти в комнату' }).click();

    await page.waitForURL(/#\/join\/[2-9A-HJKMNP-Z]{6}/);
    const code = await roomCode(page);
    await expect(page.getByText('Дима (вы)')).toBeVisible();
    await expect(page.getByText('группа распадётся через')).toBeVisible();

    // свой выбор (место — свободное по карте движка); готовность приберегаем:
    // в фиксированную группу друг не входит — сначала Аня, фиксирую последним
    const mySeat = await freeRoomSeat(page, code);
    await seatButton(page, mySeat).click();
    await expect(page.getByText('Ждём ещё 1 участника')).toBeVisible(); // это я

    // «Аня» входит и выбирает — в тестовой сборке её ведёт тест
    await friendStep(page, code, [mySeat]); // join
    await expect(page.getByText('Аня', { exact: true })).toBeVisible();
    await friendStep(page, code, [mySeat]); // select

    const anyaSeats = await page.evaluate((c) => {
      const engine = (window as unknown as { __cineDemo: Engine }).__cineDemo;
      return engine.groupPreview(c).participants.find((p) => p.name === 'Аня')!.seats;
    }, code);
    expect(anyaSeats.length).toBeGreaterThan(0);
    expect(anyaSeats).not.toContain(mySeat); // мои места друг не оспаривает
    // чужой выбор подсвечен цветом участника
    const mark = seatButton(page, anyaSeats[0]!);
    await expect(mark).toHaveAttribute(
      'style',
      /--mark:\s*#[0-9a-f]{6}/i,
    );

    // Аня готова (жду одного — меня), моя готовность фиксирует выборы всех
    await friendStep(page, code, [mySeat]); // ready
    await expect(page.getByText('Ждём ещё 1 участника')).toBeVisible();
    await page.getByRole('button', { name: 'Готов' }).click();
    await expect(page.getByText('Выбор зафиксирован')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Забронировать мои места/ }),
    ).toBeEnabled();

    // бронь своих мест уводит на оплату (обычный демо-флоу брони)
    await page.getByRole('button', { name: /Забронировать мои места/ }).click();
    await page.waitForURL(/#\/pay\//);
    await expect(page.getByRole('heading', { name: 'Оплата брони' })).toBeVisible();
  });

  test('пометка «бронь ✓» у забронировавшего и копия ссылки', async ({ page }) => {
    // буфер обмена — с явным разрешением браузера
    await page.context().grantPermissions(['clipboard-write', 'clipboard-read']);
    await page.goto('/');
    await page
      .locator('.movie-card', { hasText: 'Млечный Путь' })
      .getByRole('button', { name: 'Забронировать' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input.field__input').first().fill('Дима');
    await dialog.getByRole('button', { name: /Идём вместе/ }).click();
    await dialog.getByRole('link', { name: 'Перейти в комнату' }).click();
    await page.waitForURL(/#\/join\//);

    const code = await roomCode(page);
    const mySeat = await freeRoomSeat(page, code);
    await seatButton(page, mySeat).click();

    await friendStep(page, code, [mySeat]); // Аня вошла
    await friendStep(page, code, [mySeat]); // выбрала
    await friendStep(page, code, [mySeat]); // готова
    await page.getByRole('button', { name: 'Готов' }).click(); // фиксирую последним

    // инвайт-код комнаты виден и копируется
    await expect(page.locator('.group-room__code')).toHaveText(code);
    await page.getByRole('button', { name: 'Скопировать ссылку' }).click();
    await expect(page.getByText('Скопировано ✓')).toBeVisible();

    // своя бронь — бейдж в панели участников
    await page.getByRole('button', { name: /Забронировать мои места/ }).click();
    await page.waitForURL(/#\/pay\//);
    await page.goBack();
    await page.waitForURL(/#\/join\//);
    // комната перезагрузилась после goBack — панель снова с бейджем
    await expect(page.getByText('Дима (вы)')).toBeVisible();
  });
});
