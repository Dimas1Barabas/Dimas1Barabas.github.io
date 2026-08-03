# TaskFlow — менеджер задач на Vue 3

Учебный проект, чтобы посмотреть, как пишется код на современном Vue: Composition API,
`<script setup>` + TypeScript, Vue Router, Pinia. Несколько страниц, тёмная тема,
сохранение данных в localStorage и drag-and-drop.

## Технологии

| Инструмент        | Для чего                          |
| ----------------- | --------------------------------- |
| **Vue 3**         | UI-фреймворк (`<script setup>`)   |
| **TypeScript**    | Типизация компонентов и стора     |
| **Vue Router**    | Маршрутизация между страницами    |
| **Pinia**         | Управление состоянием             |
| **Svelte 5**      | Pomodoro-виджет (микрофронт)      |
| **Vite**          | Сборка и dev-сервер               |

## Возможности

- 🔎 Список задач с поиском, фильтрами (статус, приоритет, категория) и сортировкой
- ➕ Создание / редактирование / удаление задач через модальное окно
- 🗂️ Канбан-доска с перетаскиванием карточек между колонками
- 📊 Дашборд со статистикой, прогрессом выполнения и ближайшими дедлайнами
- 🍅 Pomodoro-таймер «Фокус» — **микрофронт на Svelte**, встроенный как Custom Element
- 🌙 Тёмная и светлая темы (выбор запоминается)
- 💾 Автосохранение в localStorage

## Микрофронт на Svelte

Страница **Фокус** (`/focus`) использует Pomodoro-таймер, написанный на **Svelte 5**.
Это отдельный подпроект `focus-timer/`, который собирается в саморегистрирующийся
**Custom Element** (`<focus-timer>`) и кладётся в `public/`. Vue-приложение грузит
бандл в рантайме через `<script>` и общается с виджетом через DOM-событие `complete`.

Архитектура:

```
focus-timer/  →  pnpm build  →  public/focus-timer.js  →  Vue грузит в рантайме
  (Svelte)                          (IIFE Custom Element)      <focus-timer @complete>
```

Полностью пересобрать виджет и приложение:

```bash
pnpm build:widget   # только Svelte-виджет → public/focus-timer.js
pnpm build:all      # виджет + Vue-приложение
```

Изменять виджет можно отдельно: `pnpm -C focus-timer dev` поднимет standalone-режим без Vue.

## Запуск

```bash
pnpm install      # установка зависимостей
pnpm dev          # dev-сервер на http://localhost:5173
pnpm build        # production-сборка в dist/
pnpm preview      # предпросмотр собранной версии
pnpm type-check   # проверка типов без сборки
```

## Структура

```
src/
├─ assets/styles/      глобальные стили и дизайн-токены (CSS-переменные, темы)
├─ components/
│  ├─ layout/          AppHeader (навигация + переключатель темы), AppFooter
│  ├─ ui/              переиспользуемые базовые компоненты (Button, Input, Modal, …)
│  └─ tasks/           TaskCard, KanbanCard, FilterBar, TaskForm
├─ composables/        useLocalStorage, useTheme
├─ router/             конфигурация Vue Router
├─ stores/             Pinia-стор задач (CRUD, фильтры, статистика)
├─ types/              доменные типы и справочники
├─ utils/              утилиты форматирования дат
└─ views/              страницы: Dashboard, Tasks, Board, Focus, About, NotFound

focus-timer/           отдельный Svelte-микрофронт (Pomodoro), собирается в Custom Element
public/focus-timer.js  собранный бандл виджета (грузится Vue в рантайме)
```

## Что посмотреть в коде

- `stores/tasks.ts` — setup-store на Pinia с геттерами через `computed`
- `components/tasks/FilterBar.vue` — `storeToRefs` для реактивного доступа к стору
- `components/ui/BaseModal.vue` — `<Teleport>`, `<Transition>`, `defineEmits`
- `components/ui/BaseInput.vue` — `defineModel()` для `v-model`
- `views/BoardView.vue` — нативный HTML5 drag-and-drop + `<TransitionGroup>`
- `composables/useTheme.ts` — реактивная тема с персистентностью
