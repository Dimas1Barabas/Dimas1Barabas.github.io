import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  // Базовый путь = подпапка, в которой лежит сборка на GitHub Pages.
  // Совпадает с базой роутера (createWebHistory(import.meta.env.BASE_URL)).
  base: '/Vue/dist/',
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // <focus-timer> — Custom Element из Svelte-микрофронта, не Vue-компонент.
          isCustomElement: (tag) => tag === 'focus-timer',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    open: false,
  },
})
