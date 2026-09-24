import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Movie, User } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useRecommendationsStore } from '@/entities/recommendations/model/store';
import BookingModal from '@/features/booking-flow/ui/BookingModal.vue';
import ReviewModal from '@/features/review/ui/ReviewModal.vue';
import HomeView from '@/pages/home/ui/HomeView.vue';

const movie: Movie = {
  id: 'm-1',
  title: 'Рекурсия',
  description: 'Фильм о вложенных снах.',
  genre: 'хоррор',
  genreIcon: '👻',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  ratingAvg: 4.5,
  ratingCount: 2,
  sessions: [
    // локальные даты далеко в будущем — не зависим от «сейчас»
    { id: 's-1', hall: 'IMAX', startsAt: new Date(2030, 0, 10, 19, 0).toISOString() },
    { id: 's-2', hall: 'Красный', startsAt: new Date(2030, 0, 11, 21, 0).toISOString() },
  ],
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

/** роутер с маршрутом оплаты — HomeView после брони ведёт на /pay/:id */
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: HomeView },
      { path: '/pay/:bookingId', name: 'pay', component: { render: () => null } },
    ],
  });
}

function mountHome(
  pinia: ReturnType<typeof createPinia>,
  router = makeRouter(),
) {
  return mount(HomeView, {
    global: { plugins: [pinia, router], stubs: { RouterLink: RouterLinkStub } },
  });
}

/** чипы жанрового ряда (дни живут в .day-filter — отдельном ряду) */
function genreChips(wrapper: ReturnType<typeof mountHome>) {
  return wrapper.findAll('.genre-filter:not(.day-filter) .genre-filter__chip');
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

  it('после создания брони ведёт на экран оплаты', async () => {
    const { pinia, moviesStore } = setup();
    moviesStore.movies = [movie];
    const router = makeRouter();
    await router.push('/');
    await router.isReady();

    const wrapper = mountHome(pinia, router);
    wrapper.findComponent(BookingModal).vm.$emit('created', { id: 'b-42' });
    await flushPromises(); // router.push — асинхронная навигация

    expect(router.currentRoute.value.name).toBe('pay');
    expect(router.currentRoute.value.params.bookingId).toBe('b-42');
  });

  it('клик по рейтингу карточки открывает модалку отзывов', async () => {
    const { pinia, moviesStore } = setup();
    const appStore = useAppStore();
    appStore.mode = 'demo'; // демо-ветка — без сети
    moviesStore.movies = [movie];

    const wrapper = mountHome(pinia);
    expect(wrapper.findComponent(ReviewModal).props('movie')).toBeNull();

    wrapper.find('.movie-card__rating').trigger('click');
    await nextTick();

    expect(wrapper.findComponent(ReviewModal).props('movie')).toEqual(movie);
  });

  describe('Вам понравится (КиноСоветник)', () => {
    it('вошедшему с топом — блок с причинами; клик открывает модалку мест', async () => {
      const { pinia, moviesStore, authStore } = setup();
      const recosStore = useRecommendationsStore();
      recosStore.refresh = vi.fn(); // onMounted не должен ходить в сеть/движок
      authStore.token = 'jwt';
      moviesStore.movies = [movie];
      recosStore.items = [
        {
          movieId: 'm-1',
          title: 'Рекурсия',
          genre: 'хоррор',
          score: 0.9,
          reason: 'вы часто смотрите «хоррор»',
        },
      ];
      recosStore.basis = 'profile';
      recosStore.loaded = true;

      const wrapper = mountHome(pinia);
      expect(wrapper.text()).toContain('Вам понравится');
      expect(wrapper.text()).toContain('вы часто смотрите «хоррор»');
      expect(wrapper.text()).toContain('по вашим броням и отзывам');

      await wrapper.find('.recos__card').trigger('click');
      expect(wrapper.findComponent(BookingModal).props('movie')).toEqual(movie);
    });

    it('гостю или пустому топу блок не показывается', () => {
      const { pinia, moviesStore } = setup();
      const recosStore = useRecommendationsStore();
      recosStore.refresh = vi.fn();
      moviesStore.movies = [movie];
      recosStore.loaded = true;
      recosStore.basis = 'unavailable';

      const wrapper = mountHome(pinia);
      expect(wrapper.find('.recos').exists()).toBe(false);
    });
  });

  it('фильтр по жанру оставляет только его сеансы, «Все» возвращает всё', async () => {
    const { pinia, moviesStore } = setup();
    const comedy: Movie = { ...movie, id: 'm-2', title: 'Дежавю', genre: 'комедия' };
    moviesStore.movies = [movie, comedy];

    const wrapper = mountHome(pinia);
    const chips = genreChips(wrapper);
    expect(chips.map((c) => c.text())).toEqual(['Все', 'хоррор', 'комедия']);
    expect(wrapper.findAll('.movie-card')).toHaveLength(2);

    await chips.find((c) => c.text() === 'хоррор')!.trigger('click');
    expect(wrapper.findAll('.movie-card')).toHaveLength(1);
    expect(wrapper.text()).toContain('Рекурсия');
    expect(wrapper.text()).not.toContain('Дежавю');

    const allChip = genreChips(wrapper).find((c) => c.text() === 'Все')!;
    await allChip.trigger('click');
    expect(wrapper.findAll('.movie-card')).toHaveLength(2);
  });

  it('выбранный жанр исчез из афиши — фильтр мягко сбрасывается', async () => {
    const { pinia, moviesStore } = setup();
    const comedy: Movie = { ...movie, id: 'm-2', title: 'Дежавю', genre: 'комедия' };
    moviesStore.movies = [movie, comedy];

    const wrapper = mountHome(pinia);
    const horrorChip = wrapper
      .findAll('.genre-filter__chip')
      .find((c) => c.text() === 'хоррор')!;
    await horrorChip.trigger('click');
    expect(wrapper.findAll('.movie-card')).toHaveLength(1);

    // перезагрузили афишу — хоррора в ней больше нет
    moviesStore.movies = [comedy];
    await nextTick();

    expect(wrapper.findAll('.movie-card')).toHaveLength(1);
    expect(wrapper.text()).toContain('Дежавю');
    // активен снова «Все» (в жанровом ряду — дни не трогаем)
    const activeChip = wrapper.find(
      '.genre-filter:not(.day-filter) .genre-filter__chip--active',
    );
    expect(activeChip.text()).toBe('Все');
  });

  describe('фильтр по дню', () => {
    afterEach(() => vi.useRealTimers());

    /** системное «сейчас» — 10 января 2030, день первого сеанса фикстуры */
    function fakeNow() {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2030, 0, 10, 12, 0));
    }

    /** фильм с сеансом только завтра (11 января) */
    const tomorrowMovie: Movie = {
      ...movie,
      id: 'm-2',
      title: 'Завтрашний',
      genre: 'комедия',
      sessions: [
        { id: 's-3', hall: 'IMAX', startsAt: new Date(2030, 0, 11, 19, 0).toISOString() },
      ],
    };

    function chip(wrapper: ReturnType<typeof mountHome>, label: string) {
      const found = wrapper
        .findAll('.genre-filter__chip')
        .find((c) => c.text() === label);
      if (!found) throw new Error(`нет чипа «${label}»`);
      return found;
    }

    it('«Сегодня» — только фильмы с сеансом сегодня', async () => {
      fakeNow();
      const { pinia, moviesStore } = setup();
      moviesStore.movies = [movie, tomorrowMovie];

      const wrapper = mountHome(pinia);
      expect(wrapper.findAll('.movie-card')).toHaveLength(2);

      await chip(wrapper, 'Сегодня').trigger('click');
      expect(wrapper.findAll('.movie-card')).toHaveLength(1);
      expect(wrapper.text()).toContain('Рекурсия');
      expect(wrapper.text()).not.toContain('Завтрашний');
    });

    it('«Завтра» — только завтрашние, «Вся неделя» возвращает всё', async () => {
      fakeNow();
      const { pinia, moviesStore } = setup();
      // у «Рекурсии» оставляем только сегодняшний сеанс — завтра она не подходит
      const todayOnly: Movie = { ...movie, sessions: [movie.sessions[0]] };
      moviesStore.movies = [todayOnly, tomorrowMovie];

      const wrapper = mountHome(pinia);
      await chip(wrapper, 'Завтра').trigger('click');
      expect(wrapper.findAll('.movie-card')).toHaveLength(1);
      expect(wrapper.text()).toContain('Завтрашний');

      await chip(wrapper, 'Вся неделя').trigger('click');
      expect(wrapper.findAll('.movie-card')).toHaveLength(2);
    });

    it('день и жанр работают вместе; пусто — подсказка', async () => {
      fakeNow();
      const { pinia, moviesStore } = setup();
      moviesStore.movies = [movie, tomorrowMovie];

      const wrapper = mountHome(pinia);
      await chip(wrapper, 'Сегодня').trigger('click');
      await chip(wrapper, 'комедия').trigger('click'); // у комедии сеанс только завтра

      expect(wrapper.findAll('.movie-card')).toHaveLength(0);
      expect(wrapper.text()).toContain('В этот день сеансов нет');
    });
  });
});
