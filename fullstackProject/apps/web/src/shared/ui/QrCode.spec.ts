import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import QrCode from './QrCode.vue';

describe('QrCode', () => {
  const payload =
    'CINE1|11111111-1111-4111-8111-111111111111|5-7|1789713600|2e0254421e0f61336e75bd1c6af05d99';

  it('рендерит SVG с белым полем и тёмными модулями', () => {
    const wrapper = mount(QrCode, { props: { value: payload } });

    const svg = wrapper.get('svg.qr');
    expect(svg.attributes('role')).toBe('img');
    expect(svg.attributes('aria-label')).toBe('QR-код билета');
    expect(svg.attributes('shape-rendering')).toBe('crispEdges');
    // тихая зона: viewBox на 2 модуля больше матрицы
    const [, , w] = svg.attributes('viewBox')!.split(' ').map(Number);
    expect(w).toBeGreaterThanOrEqual(23); // минимум версия 2 (25×25) для такого payload
    expect(svg.findAll('rect')).toHaveLength(1); // белая подложка
    expect(svg.find('path')).toBeTruthy();
    expect(svg.find('path')!.attributes('d').length).toBeGreaterThan(100);
  });

  it('длинный payload — матрица крупнее (версия подбирается автоматически)', () => {
    const short = mount(QrCode, { props: { value: payload } });
    const long = mount(QrCode, {
      props: { value: `${payload}|${'x'.repeat(300)}` },
    });

    const size = (w: ReturnType<typeof mount>) =>
      Number(w.get('svg').attributes('viewBox')!.split(' ')[2]);
    expect(size(long)).toBeGreaterThan(size(short));
  });

  it('детерминирован: один payload — одна матрица', () => {
    const first = mount(QrCode, { props: { value: payload } });
    const second = mount(QrCode, { props: { value: payload } });

    expect(first.get('path').attributes('d')).toBe(
      second.get('path').attributes('d'),
    );
  });
});
