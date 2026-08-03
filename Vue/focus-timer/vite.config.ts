import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Собираем виджет как IIFE-библиотеку: один саморегистрирующийся файл,
// который Vue подключает в рантайме. На выходе — ../public/focus-timer.js
export default defineConfig({
  plugins: [
    svelte({
      // Компилируем компоненты как Custom Elements (тег задаётся в <svelte:options>).
      compilerOptions: { customElement: true },
    }),
  ],
  build: {
    lib: {
      entry: 'src/main.ts',
      formats: ['iife'],
      name: 'FocusTimer',
      fileName: () => 'focus-timer.js',
    },
    // Кладём билд-артефакт в static-папку основного Vue-приложения.
    outDir: '../public',
    emptyOutDir: false,
  },
})
