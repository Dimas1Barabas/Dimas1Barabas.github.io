import { expect, test } from '@playwright/test';

/**
 * Страница «Пригласить» в демо-режиме против vite preview: код и витрину
 * отдаёт демо-движок (myReferrals — зеркало GET /referrals/my). Проверяем
 * видимый контур: код, тоталы, демо-друзья, копирование ссылки (буфер
 * в headless может быть запрещён — принимаем и фолбэк-инпут) и поле кода
 * в регистрации, предзаполненное из ?ref=.
 */

test.describe('реферальная программа (демо)', () => {
  test('код, тоталы и список друзей на /invite', async ({ page }) => {
    await page.goto('/#/invite');

    await expect(page.getByTestId('referral-code')).toHaveText('DEM0C0DE');
    // плитка «заработано»: value и label — соседние span без пробела
    await expect(page.getByTestId('total-earned')).toContainText('+300');
    await expect(page.getByTestId('total-earned')).toContainText(
      'бонусов заработано',
    );
    // демо-друзья: Мария оплатила, Пётр ещё нет — статус в строке таблицы
    await expect(
      page.getByRole('row', { name: /Мария/ }).getByText('оплатил'),
    ).toBeVisible();
    await expect(
      page.getByRole('row', { name: /Пётр/ }).getByText('ещё не оплатил'),
    ).toBeVisible();
  });

  test('копирование ссылки: буфер либо скопирован, либо показан для ручного', async ({
    page,
  }) => {
    await page.goto('/#/invite');
    await page.getByTestId('copy-link').click();

    // headless-браузер может запрещать clipboard API — оба исхода честны
    const copied = page.getByTestId('copy-link').getByText('Скопировано ✓');
    const fallback = page.getByTestId('copy-hint');
    await expect(captured(copied, fallback)).resolves.toBeTruthy();
  });

  test('ссылка приглашения предзаполняет код в регистрации', async ({
    page,
  }) => {
    await page.goto('/#/login?ref=DEM0C0DE');

    // режим регистрации открывается переключателем
    await page.getByRole('button', { name: 'Зарегистрироваться' }).first().click();

    const codeField = page.getByLabel('Код приглашения');
    await expect(codeField).toBeVisible();
    await expect(codeField).toHaveValue('DEM0C0DE');
  });
});

/** ждём хотя бы одного из двух исходов копирования */
function captured(
  copied: ReturnType<import('@playwright/test').Page['locator']>,
  fallback: ReturnType<import('@playwright/test').Page['locator']>,
): Promise<boolean> {
  return Promise.race([
    copied.waitFor().then(() => true),
    fallback.waitFor().then(() => true),
  ]);
}
