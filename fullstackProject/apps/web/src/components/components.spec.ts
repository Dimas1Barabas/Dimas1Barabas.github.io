import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Movie } from '../api/types';
import MovieCard from './MovieCard.vue';
import SeatPicker from './SeatPicker.vue';
import StatusBadge from './StatusBadge.vue';

const movie: Movie = {
  id: 'm-1',
  title: 'Рекурсия',
  description: 'Функция вызывает саму себя.',
  genre: 'хоррор',
  genreIcon: '🌀',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  sessionAt: new Date(2026, 8, 5, 22, 0).toISOString(),
};

describe('StatusBadge', () => {
  it.each([
    ['PENDING', 'в обработке'],
    ['CONFIRMED', 'подтверждена'],
    ['FAILED', 'отказ'],
  ] as const)('статус %s → подпись «%s»', (status, label) => {
    const wrapper = mount(StatusBadge, { props: { status } });
    expect(wrapper.text()).toContain(label);
    expect(wrapper.find('.status-badge').classes()).toContain(
      `status-badge--${status.toLowerCase()}`,
    );
  });
});

describe('SeatPicker', () => {
  const props = {
    rows: 8,
    seatsPerRow: 10,
    occupied: ['5-7', '1-1'],
    modelValue: [] as string[],
    max: 8,
  };

  it('рисует сетку ряд × места', () => {
    const wrapper = mount(SeatPicker, { props });
    expect(wrapper.findAll('.hall__row')).toHaveLength(8);
    expect(wrapper.findAll('.hall__seat')).toHaveLength(80);
  });

  it('занятые места заблокированы и помечены', () => {
    const wrapper = mount(SeatPicker, { props });
    const taken = wrapper.findAll('.hall__seat--taken');
    expect(taken).toHaveLength(2);
    expect(taken.every((s) => s.attributes('disabled') !== undefined)).toBe(true);
  });

  it('клик по свободному месту добавляет его в v-model, повторный — убирает', async () => {
    const wrapper = mount(SeatPicker, { props: { ...props } });

    // место «3-4» — 3-й ряд, 4-я кнопка: (3-1)*10 + 4-1 = 23-я
    const seat = wrapper.findAll('.hall__seat')[23];
    await seat.trigger('click');
    expect(wrapper.emitted('update:modelValue')![0][0]).toEqual(['3-4']);

    // возвращаем выбор в пропс (v-model), повторный клик убирает место
    await wrapper.setProps({ modelValue: ['3-4'] });
    await seat.trigger('click');
    expect(wrapper.emitted('update:modelValue')![1][0]).toEqual([]);
  });

  it('клик по занятому месту игнорируется', async () => {
    const wrapper = mount(SeatPicker, { props });

    // «1-1» — первая кнопка
    await wrapper.findAll('.hall__seat')[0].trigger('click');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('не выбирает больше max мест', async () => {
    const wrapper = mount(SeatPicker, {
      props: { ...props, modelValue: ['2-1', '2-2', '2-3', '2-4', '2-5', '2-6', '2-7', '2-8'] },
    });

    // 8 уже выбрано (max) — «3-5» не добавится: (3-1)*10+5-1 = 24-я кнопка
    await wrapper.findAll('.hall__seat')[24].trigger('click');
    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted).toBeUndefined(); // клик отброшен, события нет
  });
});

describe('MovieCard', () => {
  it('показывает название, жанр, длительность и цену', () => {
    const wrapper = mount(MovieCard, { props: { movie } });

    expect(wrapper.text()).toContain('Рекурсия');
    expect(wrapper.text()).toContain('хоррор');
    expect(wrapper.text()).toContain('1 ч 52 мин');
    expect(wrapper.text()).toContain('400 ₽');
  });

  it('градиент постера строится от hue фильма', () => {
    const wrapper = mount(MovieCard, { props: { movie } });
    const style = wrapper.find('.movie-card__poster').attributes('style') ?? '';
    expect(style).toContain('linear-gradient');
    expect(style).toContain('275');
  });

  it('клик по «Забронировать» эмитит событие book с фильмом', async () => {
    const wrapper = mount(MovieCard, { props: { movie } });
    await wrapper.find('button.btn').trigger('click');

    expect(wrapper.emitted('book')).toHaveLength(1);
    expect(wrapper.emitted('book')![0][0]).toEqual(movie);
  });
});
