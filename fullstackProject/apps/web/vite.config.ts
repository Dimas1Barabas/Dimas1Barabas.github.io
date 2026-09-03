import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// base './' — относительные пути: сборка работает и на GitHub Pages (/CineBooking/),
// и локально в docker (nginx)
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      // в dev-режиме проксируем API на локальный NestJS
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
