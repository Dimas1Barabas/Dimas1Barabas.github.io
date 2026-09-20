import { createRouter, createWebHashHistory } from 'vue-router';

// hash-история: на GitHub Pages глубокие ссылки работают без серверных редиректов
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/pages/home/ui/HomeView.vue'),
    },
    {
      path: '/bookings',
      name: 'bookings',
      component: () => import('@/pages/bookings/ui/BookingsView.vue'),
    },
    {
      path: '/my',
      name: 'my',
      component: () => import('@/pages/my-bookings/ui/MyBookingsView.vue'),
    },
    {
      path: '/pay/:bookingId',
      name: 'pay',
      component: () => import('@/pages/payment/ui/PaymentView.vue'),
    },
    {
      // QR-билеты брони «на вход в зал»: по одному на место
      path: '/ticket/:bookingId',
      name: 'ticket',
      component: () => import('@/pages/ticket/ui/TicketView.vue'),
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/pages/login/ui/AuthView.vue'),
    },
    {
      path: '/forgot-password',
      name: 'forgot-password',
      component: () => import('@/pages/forgot-password/ui/ForgotPasswordView.vue'),
    },
    {
      path: '/reset-password',
      name: 'reset-password',
      component: () => import('@/pages/reset-password/ui/ResetPasswordView.vue'),
    },
    {
      path: '/profile',
      name: 'profile',
      component: () => import('@/pages/profile/ui/ProfileView.vue'),
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/pages/admin/ui/AdminView.vue'),
    },
    {
      // админ-дашборд аналитики: в live — только админам, в демо — всем
      path: '/admin/stats',
      name: 'admin-stats',
      component: () => import('@/pages/admin-stats/ui/AdminStatsView.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

export default router;
