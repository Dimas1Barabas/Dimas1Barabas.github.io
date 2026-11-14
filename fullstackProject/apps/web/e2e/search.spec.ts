import { expect, test } from '@playwright/test';

/**
 * Поиск-бар витрины в демо-режиме против vite preview: подсказки
 * гоняет демо-движок (searchMovies — зеркало suggest API, источник
 * всегда «meilisearch», деградаций демо не знает). Проверяем видимый
 * контур целиком: дебаунс-подсказки, пусто, клавиатуру и выбор —
 * в модалку брони, как на живом стенде.
 */

test.describe('поиск по афише (демо)', () => {
  test('подсказки по подстроке названия: «рек» находит Рекурсию', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel('Поиск по афише').fill('рек');

    const listbox = page.getByRole('listbox', { name: 'Подсказки поиска' });
    await expect(listbox).toBeVisible();

    // в демо-каталоге «рек» сидит только в названии хоррора
    const option = listbox.getByRole('option', { name: 'Рекурсия' });
    await expect(option).toBeVisible();
    await expect(option).toContainText('хоррор');
    await expect(listbox.getByRole('option')).toHaveCount(1);

    // источник — движок, а не фолбэк по подстроке базы
    await expect(page.locator('.search-bar__fallback')).toHaveCount(0);
  });

  test('регистр и жанр не важны: ХОРРОР и туманность находят свои фильмы', async ({
    page,
  }) => {
    await page.goto('/');
    const input = page.getByLabel('Поиск по афише');

    // запрос капсом по жанру хоррора
    await input.fill('ХОРРОР');
    await expect(
      page
        .getByRole('listbox', { name: 'Подсказки поиска' })
        .getByRole('option', { name: 'Рекурсия' }),
    ).toBeVisible();

    // слово из названия фантастики
    await input.fill('туманность');
    await expect(
      page
        .getByRole('listbox', { name: 'Подсказки поиска' })
        .getByRole('option', { name: 'Млечный Путь' }),
    ).toBeVisible();
  });

  test('мусорный запрос — честное пусто вместо пустой панели', async ({
    page,
  }) => {
    await page.goto('/');
    // «космолёт» рядом с «Космофлотом», но подстрокой не совпадает
    await page.getByLabel('Поиск по афише').fill('космолет');

    await expect(
      page.getByText('Ничего не нашлось — попробуйте иначе'),
    ).toBeVisible();
  });

  test('один символ не беспокоит движок, Escape сворачивает панель', async ({
    page,
  }) => {
    await page.goto('/');
    const input = page.getByLabel('Поиск по афише');
    const listbox = page.getByRole('listbox', { name: 'Подсказки поиска' });

    // порог — от двух символов: панель не открывается вовсе
    await input.fill('р');
    await expect(listbox).toHaveCount(0);

    // рабочий запрос открывает, Escape сворачивает, фокус в поле
    await input.fill('рек');
    await expect(listbox).toBeVisible();
    await input.press('Escape');
    await expect(listbox).toHaveCount(0);
  });

  test('клик по подсказке открывает бронирование найденного фильма', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel('Поиск по афише').fill('дебаг');

    const option = page
      .getByRole('listbox', { name: 'Подсказки поиска' })
      .getByRole('option', { name: 'Последний дебаг' });
    await option.click();

    // выбор — та же модалка выбора мест, что с карточки фильма
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Последний дебаг');
    await expect(
      dialog.getByRole('button', { name: 'Забронировать' }),
    ).toBeVisible();
  });

  test('клавиатура: ↓ подсвечивает подсказку, Enter выбирает её', async ({
    page,
  }) => {
    await page.goto('/');
    const input = page.getByLabel('Поиск по афише');
    await input.fill('поток');

    const option = page
      .getByRole('listbox', { name: 'Подсказки поиска' })
      .getByRole('option', { name: 'Сорок девятый поток' });
    await expect(option).toBeVisible();

    await input.press('ArrowDown');
    await expect(option).toHaveAttribute('aria-selected', 'true');

    await input.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Сорок девятый поток');
  });
});
