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
      path: '/my',
      name: 'my',
      component: () => import('../views/MyBookingsView.vue'),
    },
    {
      path: '/pay/:bookingId',
      name: 'pay',
      component: () => import('../views/PaymentView.vue'),
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
    {
      // админ-дашборд аналитики: в live — только админам, в демо — всем
      path: '/admin/stats',
      name: 'admin-stats',
      component: () => import('../views/AdminStatsView.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

export default router;
