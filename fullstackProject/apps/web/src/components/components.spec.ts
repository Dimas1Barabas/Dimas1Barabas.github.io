import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Movie } from '../api/types';
import MovieCard from './MovieCard.vue';
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
