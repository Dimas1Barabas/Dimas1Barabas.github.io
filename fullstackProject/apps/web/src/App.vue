<script setup lang="ts">
import { onMounted } from 'vue';
import AppHeader from './components/AppHeader.vue';
import ModeBanner from './components/ModeBanner.vue';
import { useAppStore } from './stores/app';

const appStore = useAppStore();

onMounted(() => {
  void appStore.init();
});
</script>

<template>
  <div class="shell">
    <AppHeader />
    <ModeBanner />
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
