import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
// дисплейный шрифт с кириллицей для заголовков/цифр (woff2-подмножества,
// включая кириллицу, грузятся по unicode-range только нужные)
import '@fontsource/unbounded/500.css';
import '@fontsource/unbounded/700.css';
import './assets/main.css';

createApp(App).use(createPinia()).use(router).mount('#app');
