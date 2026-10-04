import { defineConfig, devices } from '@playwright/test';

/**
 * Браузерные UI-тесты против демо-режима: сборка build:demo-test
 * (вердикты детерминированы, «зрителями» водит тест) + vite preview
 * без бэкенда — ровно та страница, что живёт на GitHub Pages.
 * Прогон: npm run test:ui (соберёт и запустит).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    locale: 'ru-RU',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
