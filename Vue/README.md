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
| **Vite**          | Сборка и dev-сервер               |

## Возможности

- 🔎 Список задач с поиском, фильтрами (статус, приоритет, категория) и сортировкой
- ➕ Создание / редактирование / удаление задач через модальное окно
- 🗂️ Канбан-доска с перетаскиванием карточек между колонками
- 📊 Дашборд со статистикой, прогрессом выполнения и ближайшими дедлайнами
- 🌙 Тёмная и светлая темы (выбор запоминается)
- 💾 Автосохранение в localStorage

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
└─ views/              страницы: Dashboard, Tasks, Board, About, NotFound
```

## Что посмотреть в коде

- `stores/tasks.ts` — setup-store на Pinia с геттерами через `computed`
- `components/tasks/FilterBar.vue` — `storeToRefs` для реактивного доступа к стору
- `components/ui/BaseModal.vue` — `<Teleport>`, `<Transition>`, `defineEmits`
- `components/ui/BaseInput.vue` — `defineModel()` для `v-model`
- `views/BoardView.vue` — нативный HTML5 drag-and-drop + `<TransitionGroup>`
- `composables/useTheme.ts` — реактивная тема с персистентностью
