import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SeatPicker from '@/features/booking-flow/ui/SeatPicker.vue';

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
