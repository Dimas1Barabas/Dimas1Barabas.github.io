import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { AdminDayRevenue } from '../api/types';
import { dayKey } from '../utils/adminStats';
import { formatPrice } from '../utils/format';
import RevenueChart from './RevenueChart.vue';

/** SVG-график выручки: столбцы, масштаб по максимуму, нулевые дни */

function makeDays(values: number[], now = new Date()): AdminDayRevenue[] {
  return values.map((revenueRub, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (values.length - 1 - i));
    return { day: dayKey(d), bookings: revenueRub > 0 ? 1 : 0, revenueRub };
  });
}

describe('RevenueChart', () => {
  it('14 столбцов; максимальный — самый высокий, нулевой день — точка', () => {
    const values = [0, 0, 500, 0, 1500, 0, 0, 900, 0, 0, 0, 400, 0, 1200];
    const wrapper = mount(RevenueChart, { props: { days: makeDays(values) } });

    const bars = wrapper.findAll('rect');
    expect(bars).toHaveLength(14);

    const heights = bars.map((b) => Number(b.attributes('height')));
    expect(heights[4]).toBe(Math.max(...heights)); // 1500 — максимум окна
    expect(heights[1]).toBe(2); // нулевой день — точка по оси
    expect(bars[1].classes()).toContain('chart__bar--zero');

    // тултип максимального столбца несёт сумму (ru-RU даёт неразрывный пробел)
    const title = bars[4].find('title');
    expect(title?.text()).toContain(formatPrice(1500));
  });

  it('сегодняшний столбец и подпись подсвечены', () => {
    const wrapper = mount(RevenueChart, {
      props: { days: makeDays([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 800]) },
    });

    const bars = wrapper.findAll('rect');
    expect(bars[13].classes()).toContain('chart__bar--today');
    expect(bars[0].classes()).not.toContain('chart__bar--today');
    const labels = wrapper.findAll('text');
    expect(labels[13].classes()).toContain('chart__label--today');
  });

  it('окно без продаж не падает: все дни — нулевые точки', () => {
    const wrapper = mount(RevenueChart, {
      props: { days: makeDays(Array.from({ length: 14 }, () => 0)) },
    });

    const heights = wrapper.findAll('rect').map((b) => Number(b.attributes('height')));
    expect(heights.every((h) => Number.isFinite(h))).toBe(true);
    expect(heights.every((h) => h === 2)).toBe(true);
  });
});
