import { createRouter, createWebHashHistory } from 'vue-router';
import { enterRoute } from '@/shared/api/analytics';

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
      // реферальная программа: код приглашения и статистика (этап 31)
      path: '/invite',
      name: 'invite',
      component: () => import('@/pages/invite/ui/InviteView.vue'),
    },
    {
      // кинобар: предзаказ попкорна и напитков к сеансу (этап 32)
      path: '/bar',
      name: 'bar',
      component: () => import('@/pages/bar/ui/BarView.vue'),
    },
    {
      // гифт-сертификаты: покупка, активация кодов, остатки (этап 33)
      path: '/gifts',
      name: 'gifts',
      component: () => import('@/pages/gift/ui/GiftsView.vue'),
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
    {
      // витрина «Поведение» (Go-Аналитик): воронка, интерес, места, время
      path: '/admin/behavior',
      name: 'admin-behavior',
      component: () => import('@/pages/admin-behavior/ui/BehaviorView.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

// просмотры страниц и активное время на маршруте: трекер сам закрывает
// dwell предыдущего и открывает новый (до пробы режима — буферизация)
router.afterEach((to) => enterRoute(to.name?.toString() ?? to.path));

export default router;
