import { expect, test } from '@playwright/test';

/**
 * Витрина демо-режима против vite preview (без бэкенда) — сборка
 * build:demo-test. Пробу /api/health preview отвечает страничкой —
 * приложение честно уходит в демо, как на GitHub Pages.
 */
test.describe('витрина демо-режима', () => {
  test('афиша грузится: hero, шесть карточек, витринная навигация', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Кино начинается с одного клика' }),
    ).toBeVisible();

    // демо-режим: разделы админа/аналитики открыты всем (витрина Pages)
    await expect(page.getByRole('link', { name: 'Админка' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Аналитика' })).toBeVisible();

    // шесть сид-фильмов; скелетоны уже сменились настоящей сеткой
    const cards = page.locator('.movie-card');
    await expect(cards).toHaveCount(6);
    await expect(page.getByTitle('Рекурсия')).toBeVisible();
  });

  test('жанр-фильтр сужает сетку, «Все» возвращает полную афишу', async ({
    page,
  }) => {
    await page.goto('/');
    const cards = page.locator('.movie-card');
    await expect(cards).toHaveCount(6);

    await page
      .locator('.genre-filter:not(.day-filter)')
      .getByRole('button', { name: 'хоррор' })
      .click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Рекурсия');

    await page
      .locator('.genre-filter:not(.day-filter)')
      .getByRole('button', { name: 'Все', exact: true })
      .click();
    await expect(cards).toHaveCount(6);
  });

  test('тумблер темы переключает и помнит выбор между перезагрузками', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'light');

    await page.locator('.theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // выбор живёт в localStorage — перезагрузка не сбрасывает
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
