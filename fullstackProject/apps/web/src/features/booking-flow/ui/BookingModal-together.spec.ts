/** BookingModal: «Идём вместе» — создание группы, инвайт-ссылка, переход в комнату. Самодостаточен: свои фикстуры и маунт. */
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Movie, SeatMap, User } from '@/shared/api/types';
import { api, saveAuth } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useGroupStore } from '@/entities/group/model/store';
import BookingModal from '@/features/booking-flow/ui/BookingModal.vue';

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
    { id: 's-1', hall: 'IMAX', startsAt: new Date(2030, 0, 10, 19, 0).toISOString() },
  ],
};

const seatMap: SeatMap = {
  sessionId: 's-1',
  layout: { rows: 3, seatsPerRow: 4 },
  occupied: ['1-1'],
  free: 11,
};

const user: User = {
  id: 'u-1',
  email: 'alice@cine.local',
  name: 'Алиса',
  role: 'user',
} as unknown as User;

/** live-режим с вошедшим пользователем: имя группы — из профиля */
function mountModal() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const appStore = useAppStore();
  const moviesStore = useMoviesStore();
  appStore.mode = 'live';
  moviesStore.loadSeats = vi.fn();
  moviesStore.loadQuote = vi.fn();
  moviesStore.startSeatStream = vi.fn();
  moviesStore.seatMap = seatMap;
  saveAuth('token', user);

  const wrapper = mount(BookingModal, {
    props: { movie },
    global: { plugins: [pinia], stubs: { Teleport: true, RouterLink: RouterLinkStub } },
  });
  return { wrapper, moviesStore };
}

function stubClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(api, 'flag').mockResolvedValue({
    key: 'checkout.new_flow',
    enabled: false,
  } as never);
});

describe('BookingModal: «Идём вместе»', () => {
  it('кнопка создаёт группу на выбранный сеанс и показывает инвайт', async () => {
    vi.spyOn(api, 'createGroup').mockResolvedValue({
      code: 'ABC234',
      participantId: 'p-1',
      state: {
        code: 'ABC234',
        sessionId: 's-1',
        status: 'picking',
        expiresAt: Date.now() + 900_000,
        conflicts: [],
        participants: [],
      },
    });
    const { wrapper } = mountModal();
    await flushPromises();

    const createBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Идём вместе'))!;
    await createBtn.trigger('click');
    await flushPromises();

    expect(api.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-1', name: 'Алиса' }),
    );
    expect(sessionStorage.getItem('cine.group.ABC234')).toBe('p-1');
    expect(wrapper.text()).toContain('Перейти в комнату');
    expect(wrapper.text()).toContain('Скопировать ссылку');
  });

  it('ссылка копируется в буфер — кнопка подтверждает', async () => {
    vi.spyOn(api, 'createGroup').mockResolvedValue({
      code: 'XYZ567',
      participantId: 'p-1',
      state: {
        code: 'XYZ567',
        sessionId: 's-1',
        status: 'picking',
        expiresAt: Date.now() + 900_000,
        conflicts: [],
        participants: [],
      },
    } as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const { wrapper } = mountModal();
    await flushPromises();

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Идём вместе'))!
      .trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Скопировать ссылку'))!
      .trigger('click');

    expect(writeText.mock.calls[0]![0]).toContain('#/join/XYZ567');
    expect(wrapper.text()).toContain('Скопировано ✓');
  });

  it('«Перейти в комнату» — ссылка на /join/:code, модалка закрывается', async () => {
    vi.spyOn(api, 'createGroup').mockResolvedValue({
      code: 'ABC234',
      participantId: 'p-1',
      state: {
        code: 'ABC234',
        sessionId: 's-1',
        status: 'picking',
        expiresAt: Date.now() + 900_000,
        conflicts: [],
        participants: [],
      },
    } as never);
    const { wrapper } = mountModal();
    await flushPromises();

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Идём вместе'))!
      .trigger('click');
    await flushPromises();

    const link = wrapper.getComponent(RouterLinkStub);
    expect(link.props('to')).toBe('/join/ABC234');
    await link.trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('провал создания — честная ошибка, без ссылки', async () => {
    vi.spyOn(api, 'createGroup').mockRejectedValue(new Error('HTTP 500'));
    const { wrapper } = mountModal();
    await flushPromises();

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Идём вместе'))!
      .trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Группа не собралась');
    expect(wrapper.text()).not.toContain('Перейти в комнату');
  });
});
