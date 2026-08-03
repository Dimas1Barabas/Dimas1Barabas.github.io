<script setup lang="ts">
import BaseCard from '@/components/ui/BaseCard.vue'

const stack = ['Vue 3', 'TypeScript', 'Vue Router', 'Pinia', 'Vite', 'Composition API']

const features = [
  'CRUD задач с сохранением в localStorage',
  'Фильтрация, поиск и сортировка списка',
  'Канбан-доска с drag-and-drop',
  'Дашборд со статистикой и прогрессом',
  'Тёмная и светлая темы с запоминанием выбора',
  'Адаптивная вёрстка и анимации переходов',
]

const patterns = [
  ['<script setup lang="ts">', 'однофайловые компоненты с TS'],
  ['defineModel() / defineProps()', 'двусторонняя привязка и типизированные пропсы'],
  ['computed + storeToRefs', 'реактивные геттеры из Pinia'],
  ['composables (useTheme, useLocalStorage)', 'переиспользуемая логика'],
]
</script>

<template>
  <div class="about">
    <header class="page-header">
      <h1 class="page-title">О проекте</h1>
      <p class="page-subtitle">TaskFlow — менеджер задач на современном стеке Vue</p>
    </header>

    <div class="about__grid">
      <BaseCard title="Технологии">
        <div class="chips">
          <span v-for="tech in stack" :key="tech" class="chip">{{ tech }}</span>
        </div>
      </BaseCard>

      <BaseCard title="Возможности">
        <ul class="features">
          <li v-for="feature in features" :key="feature" class="features__item">{{ feature }}</li>
        </ul>
      </BaseCard>
    </div>

    <BaseCard title="Какие паттерны Vue тут можно посмотреть">
      <div class="patterns">
        <div v-for="[code, desc] in patterns" :key="code" class="patterns__row">
          <code class="patterns__code">{{ code }}</code>
          <span class="patterns__desc">{{ desc }}</span>
        </div>
      </div>
    </BaseCard>

    <p class="about__note">
      Данные хранятся локально в браузере (localStorage) — можно освежить страницу, задачи
      сохранятся. Чтобы сбросить демо-данные, очистите хранилище сайта в DevTools.
    </p>
  </div>
</template>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.page-header {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.page-title {
  font-size: 1.6rem;
  font-weight: 800;
}
.page-subtitle {
  color: var(--text-muted);
  font-size: 0.95rem;
}
.about__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.chip {
  padding: 0.35rem 0.75rem;
  background: var(--primary-soft);
  color: var(--primary);
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 600;
}
.features {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.features__item {
  position: relative;
  padding-left: 1.25rem;
  font-size: 0.92rem;
}
.features__item::before {
  content: '✓';
  position: absolute;
  left: 0;
  color: var(--success);
  font-weight: 700;
}
.patterns {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.patterns__row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.patterns__code {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.82rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.2rem 0.5rem;
  color: var(--primary);
}
.patterns__desc {
  font-size: 0.9rem;
  color: var(--text-muted);
}
.about__note {
  font-size: 0.88rem;
  color: var(--text-muted);
  line-height: 1.6;
}

@media (max-width: 820px) {
  .about__grid {
    grid-template-columns: 1fr;
  }
}
</style>
