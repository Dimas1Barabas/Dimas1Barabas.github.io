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
      <RouterView />
    </main>
    <footer class="footer container">
      <span
        >CineBooking — учебное фулстек-демо · исходники в репозитории
        сайта</span
      >
    </footer>
  </div>
</template>
