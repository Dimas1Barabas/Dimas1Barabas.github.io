import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import type { Movie } from '@/shared/api/types';
import MovieCard from '@/entities/movie/ui/MovieCard.vue';

const movie: Movie = {
  id: 'm-1',
  title: 'Рекурсия',
  description: 'Функция вызывает саму себя.',
  genre: 'хоррор',
  genreIcon: '🌀',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  ratingAvg: 4.5,
  ratingCount: 2,
  sessions: [
    // «завтра» относительно типичной даты запуска — карточка покажет будущее
    { id: 's-1', hall: 'IMAX', startsAt: new Date(2030, 0, 5, 22, 0).toISOString() },
    { id: 's-2', hall: 'Красный', startsAt: new Date(2030, 0, 6, 15, 0).toISOString() },
  ],
};

describe('MovieCard', () => {
  it('показывает название, жанр, длительность и цену', () => {
    const wrapper = mount(MovieCard, { props: { movie } });

    expect(wrapper.text()).toContain('Рекурсия');
    expect(wrapper.text()).toContain('хоррор');
    expect(wrapper.text()).toContain('1 ч 52 мин');
    expect(wrapper.text()).toContain('400 ₽');
  });

  it('мета — строка ближайших сеансов', () => {
    const wrapper = mount(MovieCard, { props: { movie } });

    // оба сеанса будущие: «22:00 · ещё не названные дни» — проверяем время
    expect(wrapper.find('.movie-card__meta').text()).toContain('22:00');
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

  it('рейтинг: звёзды по округлённой средней и счётчик отзывов', () => {
    const wrapper = mount(MovieCard, {
      props: { movie: { ...movie, ratingAvg: 3.6, ratingCount: 2 } },
    });

    // Math.round(3,6) = 4 заполненные звезды из 5
    expect(wrapper.findAll('.rating__star--filled')).toHaveLength(4);
    expect(wrapper.findAll('.rating__star')).toHaveLength(5);
    expect(wrapper.find('.movie-card__rating').text()).toContain('3,6');
    expect(wrapper.find('.movie-card__rating').text()).toContain('2');
  });

  it('без отзывов — «Отзывов ещё нет», ряд кликабелен', async () => {
    const unrated = { ...movie, ratingAvg: 0, ratingCount: 0 };
    const wrapper = mount(MovieCard, { props: { movie: unrated } });

    expect(wrapper.find('.movie-card__rating').text()).toContain(
      'Отзывов ещё нет',
    );
    expect(wrapper.findAll('.rating__star--filled')).toHaveLength(0);

    await wrapper.find('.movie-card__rating').trigger('click');
    expect(wrapper.emitted('reviews')).toHaveLength(1);
    expect(wrapper.emitted('reviews')![0][0]).toEqual(unrated);
  });

  it('клик по рейтингу эмитит reviews с фильмом', async () => {
    const wrapper = mount(MovieCard, { props: { movie } });
    await wrapper.find('.movie-card__rating').trigger('click');

    expect(wrapper.emitted('reviews')).toHaveLength(1);
    expect(wrapper.emitted('reviews')![0][0]).toEqual(movie);
  });
});
