import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { RouterLinkStub } from '@vue/test-utils';
import AdminStatsView from '@/pages/admin-stats/ui/AdminStatsView.vue';
import { saveAuth } from '@/shared/api/client';
import type { AdminStats } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useStatsStore } from '@/entities/stats/model/store';
import { dayKey } from '@/shared/lib/admin-stats';
import { formatPrice } from '@/shared/lib/format';

/** экран /admin/stats: доступ, плитки, топ, заполняемость, демо-пометка */

function fixture(): AdminStats {
  return {
    totals: {
      bookingsTotal: 9,
      confirmed: 4,
      revenueRub: 8800,
      avgTicketRub: 2200,
      seatsSold: 11,
      upcomingOccupancyPct: 25,
      moviesCount: 6,
      reviewsCount: 4,
      avgRating: 4.5,
    },
    byStatus: {
      PENDING_PAYMENT: 1,
      PENDING: 0,
      CONFIRMED: 4,
      FAILED: 1,
      EXPIRED: 2,
      CANCELLING: 0,
      CANCELLED: 1,
    },
    topMovies: [
      { movieId: 'm-1', title: 'Фильм А', bookings: 3, seats: 7, revenueRub: 6300 },
      { movieId: 'm-2', title: 'Фильм Б', bookings: 1, seats: 4, revenueRub: 2500 },
    ],
    upcomingSessions: [
      {
        sessionId: 's-1',
        movieTitle: 'Фильм А',
        hall: 'IMAX',
        startsAt: new Date(Date.now() + 3600_000).toISOString(),
        occupied: 40,
        capacity: 80,
        occupancyPct: 50,
      },
      {
        sessionId: 's-2',
        movieTitle: 'Фильм Б',
        hall: 'Красный',
        startsAt: new Date(Date.now() + 7200_000).toISOString(),
        occupied: 72,
        capacity: 80,
        occupancyPct: 90,
      },
    ],
    revenueByDay: Array.from({ length: 14 }, (_, i) => ({
      day: dayKey(new Date(Date.now() - (13 - i) * 86_400_000)),
      bookings: i === 13 ? 4 : 0,
      revenueRub: i === 13 ? 8800 : 0,
    })),
  };
}

function setup() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const app = useAppStore();
  const auth = useAuthStore();
  const stats = useStatsStore();
  stats.refresh = vi.fn();
  return { pinia, app, auth, stats };
}

function mountView(pinia: ReturnType<typeof createPinia>) {
  return mount(AdminStatsView, {
    global: { plugins: [pinia], stubs: { RouterLink: RouterLinkStub } },
  });
}

describe('AdminStatsView', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('live без прав: пояснение вместо данных, запрос не уходит', () => {
    const { pinia, app, stats } = setup();
    app.mode = 'live';

    const wrapper = mountView(pinia);

    expect(wrapper.text()).toContain('администраторам');
    expect(wrapper.findAll('.stat')).toHaveLength(0);
    expect(stats.refresh).not.toHaveBeenCalled();
  });

  it('live админ: refresh на монтировании, плитки, топ и пороги цвета', () => {
    // auth-стор читает сессию из localStorage при создании — сеем ДО mount
    saveAuth('test-token', {
      id: 'u-1',
      email: 'admin@test.local',
      name: 'Админ',
      role: 'admin',
      createdAt: new Date().toISOString(),
    });
    const { pinia, app, stats } = setup();
    app.mode = 'live';
    stats.admin = fixture();
    stats.source = 'db';

    const wrapper = mountView(pinia);

    expect(stats.refresh).toHaveBeenCalledTimes(1);
    // 9 плиток сводки + 7 статусов
    expect(wrapper.findAll('.stat')).toHaveLength(16);
    expect(wrapper.text()).toContain(formatPrice(8800)); // ru-RU: неразрывный пробел
    expect(wrapper.text()).toContain('средний чек');

    // топ: два фильма, полоса лидера — во всю ширину
    const rows = wrapper.findAll('.stats__row');
    expect(rows).toHaveLength(4); // 2 топ + 2 сеанса
    const fills = wrapper.findAll('.occupancy__fill');
    expect(fills[0].attributes('style')).toContain('width: 100%');

    // заполняемость: 50% — жёлтая, 90% — красная
    const sessionFills = fills.slice(2);
    expect(sessionFills[0].classes()).toContain('occupancy__fill--mid');
    expect(sessionFills[1].classes()).toContain('occupancy__fill--high');

    // график на месте
    expect(wrapper.find('svg.chart').exists()).toBe(true);
  });

  it('демо: доступно всем, бейдж кэша на месте', () => {
    const { pinia, app, stats } = setup();
    app.mode = 'demo';
    stats.admin = fixture();
    stats.source = 'cache';

    const wrapper = mountView(pinia);

    expect(stats.refresh).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.stats__badge').text()).toBe('из кэша');
    expect(wrapper.findAll('.stat')).toHaveLength(16);
  });

  it('ошибка загрузки: баннер с повтором, плиток нет', () => {
    const { pinia, app, stats } = setup();
    app.mode = 'demo';
    stats.admin = null;
    stats.error = 'HTTP 403';

    const wrapper = mountView(pinia);

    expect(wrapper.find('.stats__error').text()).toContain('HTTP 403');
    expect(wrapper.text()).toContain('Повторить');
    expect(wrapper.findAll('.stat')).toHaveLength(0);
  });
});
