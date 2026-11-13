/**
 * Поиск-бар витрины (этап 30): дебаунс ввода, подсказки с чипами,
 * клавиатурная навигация, пустая выдача, ошибка, фолбэк-бейдж, эпоха
 * запроса (поздний ответ старой фразы не затирает новую выдачу).
 * Store-экшен search мокается — сетевой путь покрыт e2e/demo-спеками.
 */
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import SearchBar from '@/entities/movie/ui/SearchBar.vue';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import type { SearchEnvelope } from '@/shared/api/types';

const suggestion = (id: string, title: string, overrides: Partial<SearchEnvelope['data'][number]> = {}) => ({
  id,
  title,
  genre: 'фантастика',
  genreIcon: '🌀',
  hue: 275,
  ratingAvg: 4.5,
  ...overrides,
});

function setup(search?: (q: string) => Promise<SearchEnvelope>) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const moviesStore = useMoviesStore();
  const impl =
    search ??
    (async (q: string): Promise<SearchEnvelope> => ({
      source: 'meilisearch',
      data: [suggestion('m-1', `Найдено: ${q}`)],
    }));
  const spy = vi.fn(impl);
  moviesStore.search = spy as unknown as typeof moviesStore.search;
  const wrapper = mount(SearchBar, { attachTo: document.body });
  return { wrapper, spy };
}

/** ввод + ожидание дебаунса и ответа */
async function type(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  await wrapper.find('input').setValue(text);
  await vi.advanceTimersByTimeAsync(400);
  await nextTick();
}

describe('SearchBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('короче двух символов — поиск не беспокоим', async () => {
    const { wrapper, spy } = setup();
    await type(wrapper, 'р');
    expect(spy).not.toHaveBeenCalled();
    expect(wrapper.find('.search-bar__dropdown').exists()).toBe(false);
  });

  it('после дебаунса — подсказки списком, клик отдаёт pick', async () => {
    const { wrapper } = setup();
    await type(wrapper, 'рекурс');

    const options = wrapper.findAll('.search-bar__option');
    expect(options).toHaveLength(1);
    expect(options[0].text()).toContain('Найдено: рекурс');

    await options[0].trigger('click');
    expect(wrapper.emitted('pick')?.[0]?.[0]).toMatchObject({
      id: 'm-1',
      title: 'Найдено: рекурс',
    });
  });

  it('дребезг ввода схлопывается в один запрос', async () => {
    const { wrapper, spy } = setup();
    const input = wrapper.find('input');
    await input.setValue('ре');
    await vi.advanceTimersByTimeAsync(150);
    await input.setValue('рек');
    await vi.advanceTimersByTimeAsync(150);
    await input.setValue('реку');
    await vi.advanceTimersByTimeAsync(400);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('реку');
  });

  it('клавиатура: ↓ подсвечивает, Enter выбирает, Esc закрывает', async () => {
    const { wrapper } = setup(async () => ({
      source: 'meilisearch',
      data: [suggestion('m-1', 'Рекурсия'), suggestion('m-2', 'Рекурсия 2')],
    }));
    await type(wrapper, 'рекурс');

    const input = wrapper.find('input');
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.findAll('.search-bar__option')[0].classes()).toContain(
      'search-bar__option--active',
    );
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.findAll('.search-bar__option')[1].classes()).toContain(
      'search-bar__option--active',
    );
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('pick')?.[0]?.[0]).toMatchObject({ id: 'm-2' });

    await input.trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.search-bar__dropdown').exists()).toBe(false);
  });

  it('Enter без подсветки выбирает первую подсказку', async () => {
    const { wrapper } = setup();
    await type(wrapper, 'рекурс');
    await wrapper.find('input').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('pick')?.[0]?.[0]).toMatchObject({ id: 'm-1' });
  });

  it('пустая выдача — честная заглушка, не пустой список', async () => {
    const { wrapper } = setup(async () => ({ source: 'meilisearch', data: [] }));
    await type(wrapper, 'зелёный слоник');
    expect(wrapper.find('.search-bar__empty').text()).toContain('Ничего не нашлось');
  });

  it('источник db — бейдж фолбэка, meilisearch — без бейджа', async () => {
    const { wrapper } = setup();
    await type(wrapper, 'рекурс');
    expect(wrapper.find('.search-bar__fallback').exists()).toBe(false);

    const fb = setup(async () => ({
      source: 'db',
      data: [suggestion('m-1', 'Рекурсия')],
    }));
    await type(fb.wrapper, 'рекурс');
    expect(fb.wrapper.find('.search-bar__fallback').exists()).toBe(true);
  });

  it('ошибка сети — сообщение, компонент жив', async () => {
    const { wrapper } = setup(async () => {
      throw new Error('сеть умерла');
    });
    await type(wrapper, 'рекурс');
    expect(wrapper.find('.search-bar__empty').text()).toContain('сеть умерла');
  });

  it('поздний ответ старой фразы не затирает новую выдачу (эпоха)', async () => {
    let resolveOld!: (value: SearchEnvelope) => void;
    const { wrapper } = setup((q: string): Promise<SearchEnvelope> => {
        if (q === 'стар') {
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        }
      return Promise.resolve({
        source: 'meilisearch',
        data: [suggestion('m-9', 'новая')],
      });
    });

    await wrapper.find('input').setValue('стар');
    await vi.advanceTimersByTimeAsync(400); // старый запрос повис
    await wrapper.find('input').setValue('нова');
    await vi.advanceTimersByTimeAsync(400); // новая фраза отработала
    resolveOld({ source: 'meilisearch', data: [suggestion('m-1', 'старая')] });
    await nextTick();

    const options = wrapper.findAll('.search-bar__option');
    expect(options).toHaveLength(1);
    expect(options[0].text()).toContain('новая');
  });
});
