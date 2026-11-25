import { expect, test } from '@playwright/test';

/**
 * Уровни «Киноман» (этап 38) в демо-режиме против vite preview: витрина
 * профиля и кинобар отдают демо-движок (myLoyalty — зеркало GET
 * /loyalty/my). Свежая сессия — Новичок: перк один, полоса 0%, в корзине
 * бара нет строки скидки. Навигация ссылками (SPA): движок живёт в
 * памяти страницы, reload стёр бы траты.
 */

test.describe('уровни «Киноман» (демо)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/login');
    await page.locator('button.link', { hasText: 'Зарегистрироваться' }).click();
    await page.getByLabel('Email', { exact: true }).fill(`playwright.loyalty@demo.local`);
    await page.getByLabel('Имя', { exact: true }).fill('Плейрайт Уровней');
    await page.getByLabel('Пароль', { exact: true }).fill('demo-secret-9');
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page.locator('.user-chip')).toBeVisible();
  });

  test('профиль: Новичок, один перк, прогресс 0% до Зрителя', async ({ page }) => {
    await page.locator('.user-chip').click();
    await expect(page.getByText('Уровень «Киноман»')).toBeVisible();

    await expect(page.getByTestId('loyalty-tier')).toHaveText('Новичок');
    await expect(page.getByTestId('loyalty-spent')).toContainText('0 ₽');
    await expect(page.getByText('кэшбэк 5% с каждой оплаты')).toBeVisible();
    await expect(page.getByText('С уровня «Зритель»')).toBeVisible();
    await expect(page.getByTestId('loyalty-progress')).toHaveCSS('width', '0px');
    await expect(page.getByTestId('loyalty-next')).toContainText('3 000 ₽');
    await expect(page.getByTestId('loyalty-next')).toContainText('(0%)');
  });

  test('кинобар: корзина Новичка без скидки — итог равен сумме позиций', async ({
    page,
  }) => {
    await page.goto('/#/bar');
    await page.getByTestId('bar-inc-popcorn-salted').click();

    await expect(page.getByTestId('bar-cart-total')).toHaveText('320 ₽');
    await expect(page.getByTestId('bar-cart-discount')).toHaveCount(0);
    await expect(page.getByTestId('bar-submit')).toContainText('320 ₽');
  });
});
