import { expect, test } from '@playwright/test';

/**
 * Лист ожидания на сид-аншлаге: сеанс demo-recursion-s1 («Рекурсия»,
 * ближайший будущий) выкуплен целиком сид-бронью «КиноКлуб» — модалка
 * показывает CTA вместо карты мест. Гость демо встаёт в очередь,
 * видит позицию на витрине «Бронирования» и выходит из неё.
 */
test.describe('лист ожидания (демо)', () => {
  test('аншлаг: CTA очереди, позиция на табло, выход из очереди', async ({
    page,
  }) => {
    await page.goto('/');

    const card = page.locator('.movie-card', { hasText: 'Рекурсия' });
    await card.getByRole('button', { name: 'Забронировать' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Рекурсия');

    // карта не грузится — зал выкуплен: вместо неё блок листа ожидания
    await expect(dialog.locator('.waitlist-cta')).toBeVisible();
    await expect(dialog.locator('.hall')).toBeHidden();
    await expect(dialog.getByText('Все места заняты')).toBeVisible();

    // встаём в очередь: свежий движок — позиция первая
    await dialog
      .getByRole('button', { name: 'Сообщить о свободном месте' })
      .click();
    await expect(dialog.getByText('Вы в очереди')).toBeVisible();
    await expect(dialog.getByText('позиция 1')).toBeVisible();

    // закрываем модалку кнопкой (Esc не гарантирован: после перерисовки
    // CTA фокус падает на body, хендлер на бэкдропе его не слышит)
    await page.getByRole('button', { name: 'Отмена' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // витрина «Бронирования» — демо-гость: его очередь живёт там
    await page.getByRole('link', { name: 'Бронирования' }).click();
    await expect(page.getByText('Лист ожидания (демо):')).toBeVisible();
    await expect(page.locator('.waitlist-strip .chip')).toContainText(
      'Рекурсия · в очереди, 1-й',
    );

    // возвращаемся в афишу ссылкой (не goto — перезагрузка обнулила бы
    // движок и очередь), движок помнит запись
    await page.getByRole('link', { name: 'Сеансы', exact: true }).click();
    await page
      .locator('.movie-card', { hasText: 'Рекурсия' })
      .getByRole('button', { name: 'Забронировать' })
      .click();
    await expect(page.getByRole('dialog').getByText('Вы в очереди')).toBeVisible();
    await page.getByRole('button', { name: 'Выйти из очереди' }).click();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Сообщить о свободном месте' }),
    ).toBeVisible();
  });
});
