import boundaries from 'eslint-plugin-boundaries';
import tsParser from '@typescript-eslint/parser';
import vueParser from 'vue-eslint-parser';

// FSD (feature-sliced design): слои сверху вниз — app → pages → widgets →
// features → entities → shared. Правило методологии: импортировать можно
// ТОЛЬКО из нижележащих слоёв; внутри слоя — только из своего среза
// (pages/home не импортирует pages/bookings, entities/movie не импортирует
// entities/booking). Границы закреплены линтером — нарушение = ошибка CI.

/** «свой срез того же слоя»: captured-шаблон подставляет имя среза импортёра */
const ownSlice = (type) => ({
  to: {
    element: {
      type,
      captured: { slice: '{{ from.element.captured.slice }}' },
    },
  },
});

export default [
  { ignores: ['dist/**', 'node_modules/**'] },

  {
    files: ['src/**/*.{ts,vue}'],
    plugins: { boundaries },
    languageOptions: {
      // vue-парсер для SFC, ts-парсер для содержимого <script setup lang="ts">
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
    },
    settings: {
      'boundaries/include': ['src/**/*.{ts,vue}'],
      // резолвер '@' → src по paths из tsconfig: без него алиасные импорты
      // считаются внешними и матрица слоёв их не проверяет
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
        },
      },
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/**' },
        { type: 'pages', pattern: 'src/pages/*/**', capture: ['slice'] },
        { type: 'widgets', pattern: 'src/widgets/*/**', capture: ['slice'] },
        { type: 'features', pattern: 'src/features/*/**', capture: ['slice'] },
        { type: 'entities', pattern: 'src/entities/*/**', capture: ['slice'] },
        { type: 'shared', pattern: 'src/shared/**' },
      ],
    },
    rules: {
      // каждый файл src обязан принадлежать слою — ничто не живёт «мимо» FSD
      'boundaries/no-unknown-dependencies': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // внешние пакеты (vue, pinia, @fontsource...) не ограничиваем
            {
              allow: [
                { to: { module: { origin: 'external' } } },
                { to: { module: { origin: 'core' } } },
              ],
            },
            // app — корень: можно всё ниже себя (и себя: main → router)
            {
              from: { element: { type: 'app' } },
              allow: [
                {
                  to: {
                    element: {
                      type: ['app', 'pages', 'widgets', 'features', 'entities', 'shared'],
                    },
                  },
                },
              ],
            },
            {
              from: { element: { type: 'pages' } },
              allow: [
                { to: { element: { type: ['widgets', 'features', 'entities', 'shared'] } } },
                ownSlice('pages'),
              ],
            },
            {
              from: { element: { type: 'widgets' } },
              allow: [
                { to: { element: { type: ['features', 'entities', 'shared'] } } },
                ownSlice('widgets'),
              ],
            },
            {
              from: { element: { type: 'features' } },
              allow: [
                { to: { element: { type: ['entities', 'shared'] } } },
                ownSlice('features'),
              ],
            },
            {
              from: { element: { type: 'entities' } },
              allow: [
                { to: { element: { type: 'shared' } } },
                ownSlice('entities'),
              ],
            },
            // shared — фундамент: только сам на себя (срезов не имеет)
            {
              from: { element: { type: 'shared' } },
              allow: [{ to: { element: { type: 'shared' } } }],
            },
          ],
        },
      ],
    },
  },
];
