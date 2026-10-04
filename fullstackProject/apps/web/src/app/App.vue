<script setup lang="ts">
import { onMounted } from 'vue';
import AppHeader from '@/widgets/app-header/ui/AppHeader.vue';
import { useAppStore } from '@/shared/api/app-mode';
import { useThemeStore } from '@/shared/lib/theme.store';

const appStore = useAppStore();
const themeStore = useThemeStore();

onMounted(() => {
  themeStore.init();
  void appStore.init();
});
</script>

<template>
  <div class="shell">
    <AppHeader />
    <main class="container">
      <!-- страница монтируется только после пробы API: иначе её onMounted
           звал загрузку данных ещё в режиме 'loading' — та уходила в живую
           ветку и демо на Pages могло показать ошибку вместо афиши -->
      <RouterView v-if="appStore.mode !== 'loading'" />
    </main>
    <footer class="footer container">
      <span
        >CineBooking — учебное фулстек-демо · исходники в репозитории
        сайта</span
      >
    </footer>
  </div>
</template>
