import { mount, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Movie, User } from '../api/types';
import { useAuthStore } from '../stores/auth';
import { useMoviesStore } from '../stores/movies';
import HomeView from './HomeView.vue';

const movie: Movie = {
  id: 'm-1',
  title: 'Рекурсия',
  description: 'Фильм о вложенных снах.',
  genre: 'хоррор',
  genreIcon: '👻',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  sessionAt: '2026-09-10T19:00:00Z',
};

const admin: User = {
  id: 'u-1',
  email: 'admin@cine.io',
  name: 'Админ',
  role: 'admin',
  createdAt: '2026-09-01T00:00:00Z',
};

/** свежий pinia + сторы с замоканным load(): состояние выставляет сам тест */
function setup() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const moviesStore = useMoviesStore();
  const authStore = useAuthStore();
  moviesStore.load = vi.fn(); // onMounted не должен ходить в сеть
  return { pinia, moviesStore, authStore };
}

function mountHome(pinia: ReturnType<typeof createPinia>) {
  return mount(HomeView, {
    global: { plugins: [pinia], stubs: { RouterLink: RouterLinkStub } },
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('HomeView', () => {
  it('пока афиша грузится — скелетоны вместо карточек', () => {
    const { pinia, moviesStore } = setup();
    moviesStore.loading = true;

    const wrapper = mountHome(pinia);

    expect(wrapper.findAll('.skeleton-card')).toHaveLength(6);
    expect(wrapper.find('.movie-card').exists()).toBe(false);
  });

  it('пустая афиша — подсказка без ссылки на админку', () => {
    const { pinia } = setup();

    const wrapper = mountHome(pinia);

    expect(wrapper.text()).toContain('Сеансов пока нет');
    const links = wrapper
      .findAllComponents(RouterLinkStub)
      .filter((l) => l.props('to') === '/admin');
    expect(links).toHaveLength(0);
  });

  it('пустая афиша для админа — ссылка «Добавить сеанс»', () => {
    const { pinia, authStore } = setup();
    authStore.user = admin;

    const wrapper = mountHome(pinia);

    const links = wrapper
      .findAllComponents(RouterLinkStub)
      .filter((l) => l.props('to') === '/admin');
    expect(links).toHaveLength(1);
    expect(wrapper.text()).toContain('Добавить сеанс');
  });

  it('загруженная афиша — карточки фильмов, без скелетонов', () => {
    const { pinia, moviesStore } = setup();
    moviesStore.movies = [movie];

    const wrapper = mountHome(pinia);

    expect(wrapper.findAll('.movie-card')).toHaveLength(1);
    expect(wrapper.text()).toContain('Рекурсия');
    expect(wrapper.find('.skeleton-card').exists()).toBe(false);
  });
});
