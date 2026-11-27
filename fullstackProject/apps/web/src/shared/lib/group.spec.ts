/** веб-зеркало домена групп «Идём вместе» — векторы как у API group.logic */
import { describe, expect, it } from 'vitest';
import {
  GROUP_CODE_LENGTH,
  MAX_PARTICIPANTS,
  MAX_SEATS_PER_PARTICIPANT,
  PARTICIPANT_COLORS,
  colorFor,
  everyoneReady,
  generateGroupCode,
  isValidSelection,
  normalizeName,
  selectionConflicts,
} from '@/shared/lib/group';

describe('shared/lib/group — зеркало домена групп', () => {
  it('код-приглашение: длина и алфавит без похожих', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateGroupCode();
      expect(code).toHaveLength(GROUP_CODE_LENGTH);
      expect(code).not.toMatch(/[0O1IL]/);
    }
  });

  it('палитра и цвета по индексу', () => {
    expect(new Set(PARTICIPANT_COLORS).size).toBe(MAX_PARTICIPANTS);
    expect(colorFor(0)).toBe(PARTICIPANT_COLORS[0]);
    expect(colorFor(7)).toBe(PARTICIPANT_COLORS[7]);
  });

  it('нормализация имени', () => {
    expect(normalizeName('  Аня   Иванова ')).toBe('Аня Иванова');
    expect(normalizeName('А')).toBeNull();
    expect(normalizeName('а'.repeat(61))).toBeNull();
    expect(normalizeName('а'.repeat(60))).toBe('а'.repeat(60));
    expect(normalizeName(7)).toBeNull();
    expect(normalizeName(null)).toBeNull();
  });

  it('валидация выбора: зал, дубли, лимит', () => {
    expect(isValidSelection(['5-7', '5-8'])).toBe(true);
    expect(isValidSelection(['9-1'])).toBe(false);
    expect(isValidSelection(['5-7', '5-7'])).toBe(false);
    expect(isValidSelection(['ряд-1'])).toBe(false);
    expect(
      isValidSelection(
        Array.from({ length: MAX_SEATS_PER_PARTICIPANT + 1 }, (_, i) => `1-${i + 1}`),
      ),
    ).toBe(false);
  });

  it('конфликты выборов и готовность всех', () => {
    expect(
      selectionConflicts([
        { id: 'a', seats: ['1-1', '1-2'] },
        { id: 'b', seats: ['1-1'] },
      ]).get('1-1'),
    ).toEqual(['a', 'b']);
    expect(everyoneReady([])).toBe(false);
    expect(everyoneReady([{ ready: true, seats: ['1-1'] }])).toBe(true);
    expect(everyoneReady([{ ready: true, seats: [] }])).toBe(false);
  });
});
