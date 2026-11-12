import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, clearAuth, saveAuth } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { Movie, Promo, User } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import AdminView from '@/pages/admin/ui/AdminView.vue';

/** Админка: фильм/постеры — только live-админ, промокоды — как аналитика (демо открыты) */

vi.mock('@/shared/api/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      adminPromos: vi.fn(),
      createPromo: vi.fn(),
      createMovie: vi.fn(),
      movies: vi.fn(),
      uploadPoster: vi.fn(),
      deletePoster: vi.fn(),
    },
  };
});

const adminUser: User = {
  id: 'admin-1',
  email: 'admin@cine.local',
  name: 'Админ',
  role: 'admin',
  createdAt: '2026-09-01T00:00:00Z',
};

const promoFixture = (overrides: Partial<Promo> = {}): Promo => ({
  id: 'p-live',
  code: 'LIVE10',
  kind: 'percent',
  value: 10,
  maxActivations: 50,
  usedCount: 7,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...overrides,
});

const movieFixture = (overrides: Partial<Movie> = {}): Movie => ({
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
    { id: 's-1', hall: 'IMAX', startsAt: new Date(2030, 0, 5, 22, 0).toISOString() },
  ],
  ...overrides,
});

/** монтирует страницу; mode ставим ПОСЛЕ mount — как демо-детект по /health */
async function mountAdmin() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(AdminView, { global: { plugins: [pinia] } });
  await flushPromises();
  return wrapper;
}

describe('AdminView', () => {
  beforeEach(() => {
    demoEngine.reset();
    localStorage.clear();
    vi.mocked(api.adminPromos).mockReset();
    vi.mocked(api.createPromo).mockReset();
    vi.mocked(api.movies).mockReset();
    vi.mocked(api.uploadPoster).mockReset();
    vi.mocked(api.deletePoster).mockReset();
  });
  afterEach(() => {
    clearAuth();
  });

  it('live без прав: пояснение про админа, промо-секции нет', async () => {
    const wrapper = await mountAdmin();
    useAppStore().mode = 'live';
    await flushPromises();

    expect(wrapper.text()).toContain('Раздел для администратора');
    expect(wrapper.find('.admin-promos').exists()).toBe(false);
    expect(wrapper.find('form.admin-form').exists()).toBe(false);
  });

  it('демо: промо-секция открыта всем — бейдж и сиды в списке', async () => {
    const wrapper = await mountAdmin();
    // режим — в пинию компонента (install делает её активной); watch подхватит
    useAppStore().mode = 'demo';
    await flushPromises();

    expect(wrapper.find('.admin-promos').exists()).toBe(true);
    expect(wrapper.find('.admin-promos__badge').text()).toContain('демо');
    const text = wrapper.find('.admin-promo-list').text();
    expect(text).toContain('CINE10');
    expect(text).toContain('SUMMER300');
    expect(text).toContain('EXPIRED5');
    // фильм в демо всё ещё только для live-админа
    expect(wrapper.text()).toContain('Раздел для администратора');
  });

  it('демо: создание промокода — код нормализован и в списке', async () => {
    const wrapper = await mountAdmin();
    useAppStore().mode = 'demo';
    await flushPromises();

    await wrapper.find('.promo-form input[type="text"]').setValue('sale500');
    await wrapper
      .find('.promo-form select')
      .setValue('fixed');
    const numbers = wrapper.findAll('.promo-form input[type="number"]');
    await numbers[0]!.setValue(500); // размер скидки
    await numbers[1]!.setValue(10); // лимит активаций
    await wrapper.find('.promo-form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('Промокод SALE500 создан');
    expect(wrapper.find('.admin-promo-list').text()).toContain('SALE500');
    expect(wrapper.find('.admin-promo-list').text()).toContain('−500 ₽');
  });

  it('демо: дубль кода — подсказка от ApiError, список цел', async () => {
    const wrapper = await mountAdmin();
    useAppStore().mode = 'demo';
    await flushPromises();

    await wrapper.find('.promo-form input[type="text"]').setValue('cine10');
    await wrapper.find('.promo-form').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('уже существует');
    expect(wrapper.find('.admin-promo-list').text()).toContain('CINE10');
  });

  it('live-админ: форма фильма и промо-секция, список из API', async () => {
    // auth-стор читает сессию из localStorage при создании — сеем ДО mount
    saveAuth('test-token', adminUser);
    vi.mocked(api.adminPromos).mockResolvedValue([promoFixture()]);
    // каталог для постерной секции: пуст — этот тест её не проверяет
    vi.mocked(api.movies).mockResolvedValue({ source: 'db', data: [] });

    const wrapper = await mountAdmin();
    useAppStore().mode = 'live'; // режим — в пинию компонента, после mount
    await flushPromises();

    expect(wrapper.find('.admin-promos').exists()).toBe(true);
    expect(wrapper.find('.admin-promo-list').text()).toContain('LIVE10');
    expect(wrapper.find('.admin-promo-list').text()).toContain('7/50');
    expect(wrapper.find('.admin-promos__badge').exists()).toBe(false);
    // форма фильма доступна: пояснения про «только админ» нет
    expect(wrapper.text()).not.toContain('Раздел для администратора');
    expect(wrapper.findAll('form.admin-form').length).toBe(2);
  });

  // ── Постеры (этап 29) ───────────────────────────────────────────────

  /** live-админ с каталогом из одного фильма */
  async function mountAdminWithMovie() {
    saveAuth('test-token', adminUser);
    vi.mocked(api.adminPromos).mockResolvedValue([promoFixture()]);
    vi.mocked(api.movies).mockResolvedValue({
      source: 'db',
      data: [movieFixture()],
    });
    const wrapper = await mountAdmin();
    useAppStore().mode = 'live';
    await flushPromises();
    return wrapper;
  }

  /** выбор файла в инпут строки фильма: files подменяем на инстансе */
  async function pickPosterFile(
    wrapper: Awaited<ReturnType<typeof mountAdminWithMovie>>,
    file: File,
  ) {
    const input = wrapper.find('.admin-poster input[type="file"]');
    Object.defineProperty(input.element, 'files', {
      value: [file],
      configurable: true,
    });
    await input.trigger('change');
  }

  it('live-админ: постерная секция с фильмами и мини-постерами', async () => {
    const wrapper = await mountAdminWithMovie();

    expect(wrapper.find('.admin-posters').exists()).toBe(true);
    expect(wrapper.find('.admin-poster__name').text()).toBe('Рекурсия');
    // превью тянет постер из S3 (live): img с URL без version
    const img = wrapper.find('.admin-poster__frame img');
    expect(img.attributes('src')).toBe('/api/movies/m-1/poster');
  });

  it('демо: постерной секции нет — S3-операции только при живом API', async () => {
    const wrapper = await mountAdmin();
    useAppStore().mode = 'demo';
    await flushPromises();

    expect(wrapper.find('.admin-posters').exists()).toBe(false);
  });

  it('загрузка постера: файл уходит в API, превью обновляется сразу (?v=)', async () => {
    const wrapper = await mountAdminWithMovie();
    vi.mocked(api.uploadPoster).mockResolvedValue({
      key: 'posters/m-1',
      size: 2048,
    });

    const file = new File([new Uint8Array(2048)], 'poster.png', {
      type: 'image/png',
    });
    await pickPosterFile(wrapper, file);
    expect(wrapper.find('.admin-poster__file-name').text()).toContain('poster.png');
    expect(wrapper.find('.admin-poster__size').text()).toContain('2 КБ');

    await wrapper
      .findAll('.admin-poster__actions button')
      .find((b) => b.text() === 'Загрузить')!
      .trigger('click');
    await flushPromises();

    expect(api.uploadPoster).toHaveBeenCalledWith('m-1', file);
    expect(wrapper.text()).toContain('Постер «Рекурсия» в S3 (2048 байт)');
    // бустер кэша: превью перезагружается, не дожидаясь max-age
    expect(wrapper.find('.admin-poster__frame img').attributes('src')).toBe(
      '/api/movies/m-1/poster?v=1',
    );
  });

  it('лимиты на клиенте: не-картинка и >2МБ не уходят в API', async () => {
    const wrapper = await mountAdminWithMovie();

    await pickPosterFile(
      wrapper,
      new File([new Uint8Array(64)], 'note.txt', { type: 'text/plain' }),
    );
    await wrapper
      .findAll('.admin-poster__actions button')
      .find((b) => b.text() === 'Загрузить')!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Постер: JPEG, PNG или WebP');
    expect(api.uploadPoster).not.toHaveBeenCalled();

    await pickPosterFile(
      wrapper,
      new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', {
        type: 'image/png',
      }),
    );
    await wrapper
      .findAll('.admin-poster__actions button')
      .find((b) => b.text() === 'Загрузить')!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Постер: не больше 2 МБ');
    expect(api.uploadPoster).not.toHaveBeenCalled();
  });

  it('ошибка API (415) — подсказка из тела ответа', async () => {
    const wrapper = await mountAdminWithMovie();
    vi.mocked(api.uploadPoster).mockRejectedValue(
      new ApiError('HTTP 415', 415, JSON.stringify({ message: 'постер: JPEG, PNG или WebP' })),
    );

    await pickPosterFile(
      wrapper,
      new File([new Uint8Array(64)], 'poster.png', { type: 'image/png' }),
    );
    await wrapper
      .findAll('.admin-poster__actions button')
      .find((b) => b.text() === 'Загрузить')!
      .trigger('click');
    await flushPromises();

    expect(wrapper.find('.admin-error').text()).toContain('постер: JPEG, PNG или WebP');
  });

  it('удаление постера: DELETE уходит, превью — на градиент', async () => {
    const wrapper = await mountAdminWithMovie();
    vi.mocked(api.deletePoster).mockResolvedValue(undefined);

    await wrapper
      .findAll('.admin-poster__actions button')
      .find((b) => b.text() === 'Удалить')!
      .trigger('click');
    await flushPromises();

    expect(api.deletePoster).toHaveBeenCalledWith('m-1');
    expect(wrapper.text()).toContain('снят — витрина на градиенте');
    // version вырос: img перезапрошен, 404 → градиент-фолбэк
    expect(wrapper.find('.admin-poster__frame img').attributes('src')).toBe(
      '/api/movies/m-1/poster?v=1',
    );
  });
});
