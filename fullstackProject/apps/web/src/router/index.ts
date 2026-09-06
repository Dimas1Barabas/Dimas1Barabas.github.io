import { createRouter, createWebHashHistory } from 'vue-router';

// hash-история: на GitHub Pages глубокие ссылки работают без серверных редиректов
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/HomeView.vue'),
    },
    {
      path: '/bookings',
      name: 'bookings',
      component: () => import('../views/BookingsView.vue'),
    },
    {
      path: '/architecture',
      name: 'architecture',
      component: () => import('../views/ArchitectureView.vue'),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/AuthView.vue'),
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('../views/AdminView.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

export default router;
