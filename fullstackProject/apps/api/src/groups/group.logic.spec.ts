import {
  GROUP_CODE_ALPHABET,
  GROUP_CODE_LENGTH,
  MAX_SEATS_PER_PARTICIPANT,
  PARTICIPANT_COLORS,
  colorFor,
  everyoneReady,
  generateGroupCode,
  isValidSelection,
  normalizeName,
  selectionConflicts,
} from './group.logic';

describe('group.logic — домен группы «Идём вместе»', () => {
  describe('generateGroupCode', () => {
    it('код заданной длины из алфавита без похожих символов', () => {
      const code = generateGroupCode();
      expect(code).toHaveLength(GROUP_CODE_LENGTH);
      for (const ch of code) expect(GROUP_CODE_ALPHABET).toContain(ch);
    });

    it('не содержит 0/O/1/I/L — читается с ссылки глазами', () => {
      for (let i = 0; i < 200; i += 1) {
        const code = generateGroupCode();
        expect(code).not.toMatch(/[0O1IL]/);
      }
    });

    it('детерминирован под инжектированным источником случайности', () => {
      // все индексы 0 → первый символ алфавита
      expect(generateGroupCode(() => 0)).toBe(
        GROUP_CODE_ALPHABET[0]!.repeat(GROUP_CODE_LENGTH),
      );
    });
  });

  describe('colorFor', () => {
    it('цвет по индексу входа, в границах палитры', () => {
      expect(colorFor(0)).toBe(PARTICIPANT_COLORS[0]);
      expect(colorFor(3)).toBe(PARTICIPANT_COLORS[3]);
    });

    it('палитра различима: все цвета уникальны', () => {
      expect(new Set(PARTICIPANT_COLORS).size).toBe(PARTICIPANT_COLORS.length);
    });
  });

  describe('normalizeName', () => {
    it('схлопывает пробелы и обрезает по краям', () => {
      expect(normalizeName('  Аня   Иванова ')).toBe('Аня Иванова');
    });

    it('короче двух символов — невалидно', () => {
      expect(normalizeName('А')).toBeNull();
      expect(normalizeName('  ')).toBeNull();
      expect(normalizeName(42)).toBeNull();
    });

    it('длиннее 60 — невалидно', () => {
      expect(normalizeName('а'.repeat(61))).toBeNull();
      expect(normalizeName('а'.repeat(60))).toBe('а'.repeat(60));
    });
  });

  describe('isValidSelection', () => {
    it('валидный выбор мест зала', () => {
      expect(isValidSelection(['5-7', '5-8'])).toBe(true);
    });

    it('место вне зала или не по формату — невалидно', () => {
      expect(isValidSelection(['9-1'])).toBe(false); // ряда нет
      expect(isValidSelection(['1-11'])).toBe(false); // места нет
      expect(isValidSelection(['ряд-место'])).toBe(false);
    });

    it('дубли мест — невалидно', () => {
      expect(isValidSelection(['5-7', '5-7'])).toBe(false);
    });

    it(`длиннее ${MAX_SEATS_PER_PARTICIPANT} мест — невалидно (лимит брони)`, () => {
      const seats = Array.from({ length: MAX_SEATS_PER_PARTICIPANT + 1 }, (_, i) => `1-${i + 1}`);
      expect(isValidSelection(seats)).toBe(false);
      expect(isValidSelection(seats.slice(0, MAX_SEATS_PER_PARTICIPANT))).toBe(true);
    });
  });

  describe('selectionConflicts', () => {
    it('общее место двух участников — конфликт', () => {
      const conflicts = selectionConflicts([
        { id: 'a', seats: ['5-7', '5-8'] },
        { id: 'b', seats: ['5-7'] },
      ]);
      expect(conflicts.get('5-7')).toEqual(['a', 'b']);
      expect(conflicts.has('5-8')).toBe(false);
    });

    it('без пересечений — пусто', () => {
      expect(
        selectionConflicts([
          { id: 'a', seats: ['1-1'] },
          { id: 'b', seats: ['1-2'] },
        ]).size,
      ).toBe(0);
    });
  });

  describe('everyoneReady', () => {
    it('пустая группа не готова', () => {
      expect(everyoneReady([])).toBe(false);
    });

    it('все с выбором и готовностью — готовы', () => {
      expect(
        everyoneReady([
          { ready: true, seats: ['1-1'] },
          { ready: true, seats: ['2-2'] },
        ]),
      ).toBe(true);
    });

    it('кто-то не готов или без выбора — не готовы', () => {
      expect(
        everyoneReady([
          { ready: true, seats: ['1-1'] },
          { ready: false, seats: ['2-2'] },
        ]),
      ).toBe(false);
      expect(
        everyoneReady([
          { ready: true, seats: ['1-1'] },
          { ready: true, seats: [] },
        ]),
      ).toBe(false);
    });
  });
});
