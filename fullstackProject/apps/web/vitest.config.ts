import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      // фиксация текущего уровня с запасом ~1% вниз (88.7/78.7/84.4/89.8):
      // расти можно, падать нет — прогоняется в CI скриптом test:cov
      thresholds: {
        statements: 88,
        branches: 78,
        functions: 84,
        lines: 89,
      },
    },
  },
});
