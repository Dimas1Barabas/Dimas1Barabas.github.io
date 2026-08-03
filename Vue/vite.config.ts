import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  // Относительный базовый путь — чтобы сборка работала и в подпапке GitHub Pages.
  base: './',
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
