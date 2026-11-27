import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api } from '@/shared/api/client';
import type { Booking, GroupRoomState, GroupState } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useGroupStore } from '@/entities/group/model/store';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import GroupRoomView from '@/pages/join/ui/GroupRoomView.vue';

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div>home</div>' } },
    { path: '/join/:code', name: 'group-join', component: GroupRoomView },
    { path: '/pay/:bookingId', component: { template: '<div>pay</div>' } },
  ],
});

const preview: GroupState = {
  code: 'ABC234',
  sessionId: 's-1',
  status: 'picking',
  expiresAt: Date.now() + 15 * 60_000,
  conflicts: [],
  participants: [
    { id: 'p-1', name: 'Алиса', color: '#22d3ee', seats: ['5-7'], ready: false, booked: false },
  ],
};

const roomState: GroupRoomState = {
  ...preview,
  occupied: ['1-1'],
  you: 'p-1',
  participants: [
    { ...preview.participants[0]!, seats: ['5-7'], ready: true, booked: false, online: true },
    { id: 'p-2', name: 'Борис', color: '#f472b6', seats: ['5-9'], ready: false, booked: false, online: false },
  ],
};

async function mountView(): Promise<ReturnType<typeof mount>> {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAppStore().mode = 'live';
  await router.push('/join/ABC234');
  await router.isReady();
  const wrapper = mount(GroupRoomView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

/** mount со стором, доступным до onModuleInit страницы (шпионы до входа) */
async function mountViewWithStore(
  prepare: (groupStore: ReturnType<typeof useGroupStore>) => void,
): Promise<ReturnType<typeof mount>> {
  const pinia = createPinia();
  setActivePinia(pinia);
  useAppStore().mode = 'live';
  prepare(useGroupStore());
  await router.push('/join/ABC234');
  await router.isReady();
  const wrapper = mount(GroupRoomView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(api, 'groupPreview').mockResolvedValue(preview);
  vi.spyOn(api, 'movies').mockResolvedValue({ source: 'db', data: [] });
});

describe('GroupRoomView: комната «Идём вместе»', () => {
  it('мёртвая ссылка → честный экран с возвратом в афишу', async () => {
    vi.spyOn(api, 'groupPreview').mockRejectedValue(new Error('HTTP 404'));
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('Ссылка не работает');
    expect(wrapper.text()).toContain('Группа не найдена');
  });

  it('превью: фильм не обязателен, форма имени ведёт в группу', async () => {
    const wrapper = await mountView();
    const groupStore = useGroupStore();

    expect(wrapper.text()).toContain('Вас зовут в кино');
    expect(wrapper.text()).toContain('Участников: 1');

    const enter = vi.spyOn(groupStore, 'enter').mockImplementation(() => undefined);
    await wrapper.find('input[type="text"]').setValue('Борис');
    await wrapper.find('form').trigger('submit');
    expect(enter).toHaveBeenCalledWith('ABC234', 'Борис');
  });

  it('сохранённая личность: авто-вход без формы', async () => {
    sessionStorage.setItem('cine.group.ABC234', 'p-1');
    const wrapper = await mountViewWithStore((groupStore) => {
      vi.spyOn(groupStore, 'enter').mockImplementation(() => undefined);
    });

    expect(useGroupStore().enter).toHaveBeenCalledWith('ABC234', '');
    expect(wrapper.find('form').exists()).toBe(false);
  });

  it('комната: участники с готовностью, оффлайн-приглушение, конфликты', async () => {
    const wrapper = await mountView();
    const groupStore = useGroupStore();
    groupStore.room = { ...roomState, conflicts: ['5-9'] };
    groupStore.phase = 'room';
    groupStore.mySeats = ['5-7'];
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('Алиса (вы)');
    expect(text).toContain('Борис');
    expect(text).toContain('готов');
    expect(text).toContain('Оспариваются: 5-9');
    // код-приглашения виден рядом с копированием ссылки
    expect(text).toContain('ABC234');
  });

  it('picking: «Готов» шлёт готовность, подсказка ждёт остальных', async () => {
    const wrapper = await mountView();
    const groupStore = useGroupStore();
    // Алиса уже готова, Борис выбирает — ждём одного
    groupStore.room = roomState;
    groupStore.phase = 'room';
    groupStore.mySeats = ['5-7'];
    await flushPromises();
    const toggle = vi
      .spyOn(groupStore, 'toggleReady')
      .mockImplementation(() => undefined);

    expect(wrapper.text()).toContain('Ждём ещё 1 участника');
    // Алиса уже готова — кнопка снимает готовность
    const readyBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Передумал'))!;
    await readyBtn.trigger('click');
    expect(toggle).toHaveBeenCalledWith(false);
  });

  it('fixed: бронь своих мест ведёт на оплату, бейдж прилетает', async () => {
    const wrapper = await mountView();
    const groupStore = useGroupStore();
    const bookings = useMoviesStore(); // не нужен — бронь в booking-сторе
    void bookings;
    groupStore.room = { ...roomState, status: 'fixed', conflicts: [] };
    groupStore.phase = 'room';
    groupStore.mySeats = ['5-7'];
    await flushPromises();

    const markBooked = vi
      .spyOn(groupStore, 'markBooked')
      .mockImplementation(() => undefined);
    const { useBookingsStore } = await import('@/entities/booking/model/store');
    const bookingsStore = useBookingsStore();
    vi.spyOn(bookingsStore, 'create').mockResolvedValue({ id: 'b-42' } as Booking);
    const push = vi.spyOn(router, 'push').mockImplementation(async () => undefined);

    const bookBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Забронировать мои места'))!;
    expect(bookBtn.text()).toContain('(1)');
    await bookBtn.trigger('click');
    await flushPromises();

    expect(bookingsStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's-1', seats: ['5-7'] }),
    );
    expect(markBooked).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/pay/b-42');
  });

  it('распад: экран с пояснением и возвратом', async () => {
    const wrapper = await mountView();
    const groupStore = useGroupStore();
    groupStore.phase = 'disbanded';
    await flushPromises();

    expect(wrapper.text()).toContain('Группа распалась');
    const home = wrapper.findAll('button').find((b) => b.text() === 'В афишу')!;
    const reset = vi
      .spyOn(groupStore, 'reset')
      .mockImplementation(() => undefined);
    await home.trigger('click');
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
