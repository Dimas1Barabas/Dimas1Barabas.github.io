import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/shared/api/app-mode';
import { demoEngine } from '@/shared/api/demo-engine';
import TwoFactorSection from '@/pages/profile/ui/TwoFactorSection.vue';
import { totp } from '@/shared/lib/totp';

/**
 * Секция 2FA профиля в демо-режиме: движок вместо API — витрина ходит
 * тем же контрактом (setup → QR → enable → backup один раз → устройства →
 * disable). QR рисуется (svg с path), код берём текущим — движок знает
 * секрет.
 */

function mountSection() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAppStore().mode = 'demo';
  return mount(TwoFactorSection, { global: { plugins: [pinia] } });
}

/** демо-сессия: аккаунт + вход (движок решает статус секции) */
function signIn(): void {
  demoEngine.register({
    email: 'anna@example.com',
    password: 'secret123',
    name: 'Анна',
  });
  demoEngine.login('anna@example.com', 'secret123');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
  demoEngine.reset();
});

describe('TwoFactorSection (демо-режим)', () => {
  it('выключена: приглашение и кнопка включить', async () => {
    signIn();
    const wrapper = mountSection();
    await vi.dynamicImportSettled?.();
    await nextTick();

    expect(wrapper.text()).toContain('Двухфакторная аутентификация');
    expect(wrapper.text()).toContain('Включить 2FA');
  });

  it('настройка: QR, секрет и демо-подсказка текущего кода', async () => {
    signIn();
    const wrapper = mountSection();
    await nextTick();

    await wrapper.find('button').trigger('click');
    await nextTick();

    expect(wrapper.find('svg.qr').exists()).toBe(true);
    expect(wrapper.text()).toContain('Демо без телефона');
    const secret = demoEngine.twoFactorStatus();
    expect('demoCurrentCode' in secret).toBe(true);
    expect(wrapper.text()).toContain((secret as { demoCurrentCode: string }).demoCurrentCode);
  });

  it('включение кодом: backup-коды показаны один раз, устройство позже', async () => {
    signIn();
    const wrapper = mountSection();
    await nextTick();

    await wrapper.find('button').trigger('click'); // начать настройку
    await nextTick();
    // на этапе настройки код живёт в статусе (pending ещё не включён)
    const code = (demoEngine.twoFactorStatus() as { demoCurrentCode: string })
      .demoCurrentCode;
    await wrapper.find('input[autocomplete="one-time-code"]').setValue(code);
    await wrapper.findAll('button').find((b) => b.text().includes('Подтвердить'))!.trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('один раз');
    expect(wrapper.text()).toContain('Доверенные устройства');
    expect(wrapper.text()).toContain('Пока нет');
  });

  it('выключение кодом приложения возвращает приглашение', async () => {
    signIn();
    // включим напрямую движком — UI должен показать статус
    const setup = demoEngine.twoFactorSetup();
    demoEngine.twoFactorEnable(totp(setup.secret));

    const wrapper = mountSection();
    await nextTick();
    expect(wrapper.text()).toContain('Включена');

    await wrapper.find('input[autocomplete="one-time-code"]').setValue(totp(setup.secret));
    await wrapper.findAll('button').find((b) => b.text() === 'Выключить')!.trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('Включить 2FA');
    expect(demoEngine.twoFactorStatus().enabled).toBe(false);
  });

  it('неверный код при включении — ошибка на месте, статус не меняется', async () => {
    signIn();
    const wrapper = mountSection();
    await nextTick();

    await wrapper.find('button').trigger('click');
    await nextTick();
    await wrapper.find('input[autocomplete="one-time-code"]').setValue('000000');
    await wrapper.findAll('button').find((b) => b.text().includes('Подтвердить'))!.trigger('click');
    await nextTick();

    expect(wrapper.text()).toContain('Неверный код');
    expect(demoEngine.twoFactorStatus().enabled).toBe(false);
    // всё ещё на этапе настройки — QR виден
    expect(wrapper.find('svg.qr').exists()).toBe(true);
  });

  it('доверенное устройство: «это устройство» и отзыв из витрины', async () => {
    signIn();
    const setup = demoEngine.twoFactorSetup();
    demoEngine.twoFactorEnable(totp(setup.secret));
    // доверим «браузер» через второй шаг движка
    demoEngine.logout();
    const outcome = demoEngine.login('anna@example.com', 'secret123');
    demoEngine.loginSecondFactor({
      ticket: (outcome as { ticket: string }).ticket,
      code: totp(setup.secret),
      trustDevice: true,
      deviceName: 'Тестовый браузер',
    });

    const wrapper = mountSection();
    await nextTick();
    expect(wrapper.text()).toContain('Тестовый браузер');
    expect(wrapper.text()).toContain('это устройство');

    await wrapper.findAll('button').find((b) => b.text() === 'Отозвать')!.trigger('click');
    await nextTick();
    expect(wrapper.text()).toContain('Пока нет');
    expect(demoEngine.twoFactorDevices()).toHaveLength(0);
  });
});
