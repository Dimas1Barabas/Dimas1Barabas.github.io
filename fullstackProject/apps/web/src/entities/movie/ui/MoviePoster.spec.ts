import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Movie } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import MoviePoster from '@/entities/movie/ui/MoviePoster.vue';

/**
 * Постер фильма (этап 29): img из S3 в live-режиме с fade-in после
 * загрузки, градиент по hue — фон и фолбэк, демо-режим (Pages) запрос
 * не делает вовсе. Сетевых запросов нет — режимы ставим в app-сторе,
 * @load/@error триггерим руками.
 */

const movie: Movie = {
  id: 'm-1',
  title: 'Рекурсия',
  description: 'Функция вызывает саму себя.',
  genre: 'хоррор',
  genreIcon: '🌀',
  durationMin: 112,
  priceRub: 400,
  hue: 210,
  ratingAvg: 4.5,
  ratingCount: 2,
  sessions: [
    { id: 's-1', hall: 'IMAX', startsAt: new Date(2030, 0, 5, 22, 0).toISOString() },
  ],
};

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('MoviePoster', () => {
  it('live: img с URL постера, до @load прозрачен — фон не мигает', async () => {
    useAppStore().mode = 'live';

    const wrapper = mount(MoviePoster, { props: { movie } });
    const img = wrapper.find('img.movie-poster__img');

    expect(img.attributes('src')).toBe('/api/movies/m-1/poster');
    expect(img.attributes('alt')).toBe('Постер фильма «Рекурсия»');
    expect(img.classes()).not.toContain('movie-poster__img--loaded');

    await img.trigger('load');
    expect(img.classes()).toContain('movie-poster__img--loaded');
  });

  it('live, постера нет (ошибка загрузки) — img снимается, градиент остаётся', async () => {
    useAppStore().mode = 'live';

    const wrapper = mount(MoviePoster, { props: { movie } });
    await wrapper.find('img.movie-poster__img').trigger('error');

    expect(wrapper.find('img').exists()).toBe(false);
    const style = wrapper.find('.movie-poster').attributes('style') ?? '';
    expect(style).toContain('linear-gradient');
    expect(style).toContain('210');
  });

  it('демо-режим (Pages без бэка) — запроса нет вовсе, сразу градиент', () => {
    useAppStore().mode = 'demo';

    const wrapper = mount(MoviePoster, { props: { movie } });

    expect(wrapper.find('img').exists()).toBe(false);
    const style = wrapper.find('.movie-poster').attributes('style') ?? '';
    expect(style).toContain('linear-gradient');
  });

  it('слот оверлеев рендерится поверх картинки', () => {
    useAppStore().mode = 'live';

    const wrapper = mount(MoviePoster, {
      props: { movie },
      slots: { default: '<span class="badge">хоррор</span>' },
    });

    expect(wrapper.find('.badge').text()).toBe('хоррор');
    // img — первый ребёнок, оверлеи после него (красятся поверх)
    expect(wrapper.element.children[0]?.tagName).toBe('IMG');
    expect(wrapper.element.children[1]?.tagName).toBe('SPAN');
  });

  it('переиспользование под другой фильм — новая попытка загрузки', async () => {
    useAppStore().mode = 'live';

    const wrapper = mount(MoviePoster, { props: { movie } });
    await wrapper.find('img.movie-poster__img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);

    await wrapper.setProps({ movie: { ...movie, id: 'm-2', hue: 40 } });
    const img = wrapper.find('img.movie-poster__img');
    expect(img.attributes('src')).toBe('/api/movies/m-2/poster');
    expect(img.classes()).not.toContain('movie-poster__img--loaded');
  });
});
