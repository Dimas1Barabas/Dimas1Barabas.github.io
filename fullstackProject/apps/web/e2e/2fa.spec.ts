import { expect, test } from '@playwright/test';

/**
 * 2FA в демо-режиме против vite preview: движок зеркалит TwoFactorService
 * и второй шаг логина. Видимый контур: регистрация → профиль → включение
 * по QR с демо-подсказкой кода → backup-коды один раз → выход → вход
 * паролем → шаг кода → доверенное устройство → «это устройство» в
 * витрине → отзыв возвращает второй шаг. Навигация только ссылками
 * (SPA): движок живёт в памяти страницы, reload стёр бы настройки.
 */

test.describe('2FA (демо)', () => {
  test('включить в профиле → вход с кодом → доверие браузеру → отзыв', async ({
    page,
  }) => {
    await page.goto('/#/login');

    // регистрация: режим-переключатель (link-кнопка) → форма → сразу вход
    await page
      .locator('button.link', { hasText: 'Зарегистрироваться' })
      .click();
    await page.getByLabel('Email', { exact: true }).fill('playwright.2fa@demo.local');
    await page.getByLabel('Имя', { exact: true }).fill('Плейрайт Кодов');
    await page.getByLabel('Пароль', { exact: true }).fill('demo-secret-9');
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page.locator('.user-chip')).toBeVisible();

    // профиль → секция 2FA: настройка с QR и демо-подсказкой кода
    await page.locator('.user-chip').click();
    await expect(page.getByText('Двухфакторная аутентификация')).toBeVisible();
    await page.getByTestId('twofactor-enable-btn').click();
    await expect(page.getByTestId('twofactor-qr')).toBeVisible();
    const hint = await page.getByTestId('twofactor-demo-code').textContent();
    const code = (hint ?? '').match(/\d{6}/)?.[0];
    expect(code).toBeTruthy();

    // неверный код не включает (зеркало 401 API)
    await page.getByTestId('twofactor-code-input').fill('000000');
    await page.getByTestId('twofactor-confirm-btn').click();
    await expect(page.getByText('Неверный код')).toBeVisible();

    // верный — backup-коды одним экраном
    await page.getByTestId('twofactor-code-input').fill(code!);
    await page.getByTestId('twofactor-confirm-btn').click();
    const backup = page.getByTestId('twofactor-backup');
    await expect(backup).toBeVisible();
    const codes = await backup.locator('code').allTextContents();
    expect(codes).toHaveLength(10);

    // выход → вход тем же паролем: второй шаг вместо пары
    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.getByRole('link', { name: 'Войти' }).click();
    await page.getByLabel('Email', { exact: true }).fill('playwright.2fa@demo.local');
    await page.getByLabel('Пароль', { exact: true }).fill('demo-secret-9');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByText('Код подтверждения')).toBeVisible();

    // неверный код — ошибка; верный с галочкой доверия — вход
    await page.getByTestId('login-code-input').fill('111111');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByText('Код неверен или билет входа истёк')).toBeVisible();

    const loginHint = await page.getByTestId('login-demo-code').textContent();
    const loginCode = (loginHint ?? '').match(/\d{6}/)?.[0];
    await page.getByTestId('login-code-input').fill(loginCode!);
    await page.getByTestId('login-trust-check').check();
    await page.getByLabel('Имя устройства').fill('Плейрайт Браузер');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.locator('.user-chip')).toBeVisible();

    // профиль: устройство с меткой «это устройство», отзыв
    await page.locator('.user-chip').click();
    await expect(page.getByText('Доверенные устройства')).toBeVisible();
    await expect(page.getByText('Плейрайт Браузер')).toBeVisible();
    await expect(page.getByText('это устройство')).toBeVisible();
    await page.getByRole('button', { name: 'Отозвать' }).click();
    await expect(page.getByText('Пока нет')).toBeVisible();

    // после отзыва вход снова спрашивает код
    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.getByRole('link', { name: 'Войти' }).click();
    await page.getByLabel('Email', { exact: true }).fill('playwright.2fa@demo.local');
    await page.getByLabel('Пароль', { exact: true }).fill('demo-secret-9');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByText('Код подтверждения')).toBeVisible();
  });
});
