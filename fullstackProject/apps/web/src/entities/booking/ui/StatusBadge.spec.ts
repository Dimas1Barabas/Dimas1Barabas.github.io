import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StatusBadge from '@/entities/booking/ui/StatusBadge.vue';

describe('StatusBadge', () => {
  it.each([
    ['PENDING_PAYMENT', 'ждёт оплаты'],
    ['PENDING', 'оплата проводится'],
    ['CONFIRMED', 'подтверждена'],
    ['FAILED', 'отказ'],
    ['EXPIRED', 'истекла'],
    ['CANCELLING', 'идёт возврат'],
    ['CANCELLED', 'отменена'],
  ] as const)('статус %s → подпись «%s»', (status, label) => {
    const wrapper = mount(StatusBadge, { props: { status } });
    expect(wrapper.text()).toContain(label);
    expect(wrapper.find('.status-badge').classes()).toContain(
      `status-badge--${status.toLowerCase()}`,
    );
  });
});
