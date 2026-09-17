import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// base './' — относительные пути: сборка работает и на GitHub Pages (/CineBooking/),
// и локально в docker (nginx)
// '@' — FSD: кросс-слойные импорты идут через алиас, а не '../../../../../'
export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // в dev-режиме проксируем API на локальный NestJS
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
