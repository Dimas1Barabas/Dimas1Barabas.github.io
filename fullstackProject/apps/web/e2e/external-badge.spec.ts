import { expect, test } from '@playwright/test';

/**
 * Внешний блок карточки афиши (этап 37) в демо-режиме против vite
 * preview: демо-движок несёт внешний блок у четырёх фильмов из шести
 * (зеркало каталога мока kinoapi) — витрина показывает ОБА состояния
 * рядом: бейдж рейтинга/метаданные/трейлер у синкнутых и чистую
 * карточку у остальных. Деградация — нормальное состояние витрины.
 */

/** карточка по подстроке названия */
function card(page: import('@playwright/test').Page, title: string) {
  return page.locator('.movie-card', { hasText: title });
}

test.describe('внешние метаданные карточки (демо)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.movie-card')).toHaveCount(6);
  });

  test('синкнутый фильм: бейдж рейтинга, мета, команда и трейлер', async ({
    page,
  }) => {
    const milky = card(page, 'Млечный Путь');
    await expect(milky).toBeVisible();

    // бейдж на постере: рейтинг справочника по его шкале
    await expect(milky.locator('.movie-card__kp')).toHaveText('★ 8.3');

    // год · страна · возраст + команда (режиссёр и первые два актёра)
    const external = milky.locator('.movie-card__external');
    await expect(external).toContainText('2025 · Россия · 16+');
    await expect(external).toContainText('А. Режиссёр · И. Актёр · Е. Актриса');

    // трейлер: внешняя ссылка в новой вкладе, не кнопка брони
    const trailer = milky.locator('a.movie-card__trailer');
    await expect(trailer).toHaveAttribute(
      'href',
      'https://trailers.example/milky-way-nebula',
    );
    await expect(trailer).toHaveAttribute('target', '_blank');
    await expect(trailer).toHaveAttribute('rel', 'noopener');
  });

  test('несинкнутый фильм: карточка как была — без бейджа и трейлера', async ({
    page,
  }) => {
    // «Госпожа Кэш» — справочник не знает, внешнего блока нет
    const lady = card(page, 'Госпожа Кэш');
    await expect(lady).toBeVisible();
    await expect(lady.locator('.movie-card__kp')).toHaveCount(0);
    await expect(lady.locator('.movie-card__external')).toHaveCount(0);
    await expect(lady.locator('a.movie-card__trailer')).toHaveCount(0);

    // книга/цена/сеансы на месте — карточка не развалилась
    await expect(lady).toContainText('Забронировать');
    await expect(lady).toContainText('380 ₽');
  });

  test('у части афиши блок есть, у части нет — оба состояния рядом', async ({
    page,
  }) => {
    // 4 из 6 сидов демо несут внешний блок
    await expect(page.locator('.movie-card__kp')).toHaveCount(4);
    await expect(page.locator('a.movie-card__trailer')).toHaveCount(4);
  });

  test('рейтинг своих отзывов не путается с внешним: звёзды остаются из 5', async ({
    page,
  }) => {
    // «Рекурсия» с внешним 7.9 и местными отзывами: блок отзывов — свой,
    // внешний бейдж — свой, они не слипаются
    const recursion = card(page, 'Рекурсия');
    await expect(recursion.locator('.movie-card__kp')).toHaveText('★ 7.9');
    const stars = recursion.locator('.rating__star');
    await expect(stars).toHaveCount(5);
  });
});
