import { firstValueFrom, take } from 'rxjs';
import {
  GroupFixedError,
  GroupFullError,
  GroupNotFoundError,
  GroupsService,
  NameInvalidError,
  ReadyNeedsSeatsError,
  SelectionInvalidError,
} from './groups.service';
import { MAX_PARTICIPANTS } from './group.logic';

describe('GroupsService — in-memory стор групп', () => {
  let service: GroupsService;
  let nowMs: number;

  beforeEach(() => {
    service = new GroupsService();
    nowMs = 1_700_000_000_000;
    service.now = () => nowMs;
  });

  const createGroup = (name = 'Алиса', sessionId = 'session-1') =>
    service.create(sessionId, name);

  const join = (code: string, name: string, participantId?: string) =>
    service.join(code, name, participantId);

  const readyAll = (code: string, ids: string[]) => {
    for (const id of ids) service.setReady(code, id, true);
  };

  describe('создание и вход', () => {
    it('создатель — первый участник с нулевым цветом', () => {
      const res = createGroup('Алиса');
      expect(res.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
      expect(res.state.status).toBe('picking');
      expect(res.state.participants).toHaveLength(1);
      expect(res.state.participants[0]).toMatchObject({
        name: 'Алиса',
        ready: false,
        booked: false,
      });
      expect(res.state.participants[0]!.seats).toEqual([]);
    });

    it('имя нормализуется как у брони', () => {
      const res = createGroup('  Аня   Иванова ');
      expect(res.state.participants[0]!.name).toBe('Аня Иванова');
    });

    it('плохое имя create/join — NameInvalidError', () => {
      expect(() => createGroup('А')).toThrow(NameInvalidError);
      const res = createGroup('Алиса');
      expect(() => join(res.code, 'Б')).toThrow(NameInvalidError);
    });

    it('второй участник входит, цвет по индексу входа', () => {
      const res = createGroup('Алиса');
      const joined = join(res.code, 'Борис');
      expect(joined.state.participants).toHaveLength(2);
      const colors = joined.state.participants.map((p) => p.color);
      expect(new Set(colors).size).toBe(2);
    });

    it('реконнект по participantId — та же личность, имя не перезатирается', () => {
      const res = createGroup('Алиса');
      const again = join(res.code, 'Какугодно', res.participantId);
      expect(again.participantId).toBe(res.participantId);
      expect(again.state.participants).toHaveLength(1);
      expect(again.state.participants[0]!.name).toBe('Алиса');
    });

    it('чужой participantId — вход как новый участник', () => {
      const res = createGroup('Алиса');
      const joined = join(res.code, 'Борис', 'не-наш-id');
      expect(joined.participantId).not.toBe('не-наш-id');
      expect(joined.state.participants).toHaveLength(2);
    });

    it('лимит участников — GroupFullError', () => {
      const res = createGroup('Алиса');
      for (let i = 2; i <= MAX_PARTICIPANTS; i += 1) {
        join(res.code, `Участник ${i}`);
      }
      expect(() => join(res.code, 'Девятый')).toThrow(GroupFullError);
    });

    it('несуществующая группа — GroupNotFoundError', () => {
      expect(() => join('ZZZZZZ', 'Борис')).toThrow(GroupNotFoundError);
      expect(service.snapshot('ZZZZZZ')).toBeNull();
    });
  });

  describe('выбор мест', () => {
    it('замена выбора целиком', () => {
      const res = createGroup();
      const state = service.setSelection(res.code, res.participantId, ['5-7']);
      expect(state.participants[0]!.seats).toEqual(['5-7']);
      const next = service.setSelection(res.code, res.participantId, ['1-1', '1-2']);
      expect(next.participants[0]!.seats).toEqual(['1-1', '1-2']);
    });

    it('невалидный выбор — SelectionInvalidError (дубль/вне зала/лимит)', () => {
      const res = createGroup();
      expect(() =>
        service.setSelection(res.code, res.participantId, ['5-7', '5-7']),
      ).toThrow(SelectionInvalidError);
      expect(() =>
        service.setSelection(res.code, res.participantId, ['9-1']),
      ).toThrow(SelectionInvalidError);
      expect(() =>
        service.setSelection(res.code, res.participantId, ['не-место']),
      ).toThrow(SelectionInvalidError);
      expect(() =>
        service.setSelection(res.code, res.participantId, [
          '1-1', '1-2', '1-3', '1-4', '1-5', '1-6', '1-7', '1-8', '1-9',
        ]),
      ).toThrow(SelectionInvalidError);
    });

    it('смена выбора снимает готовность (пока не все готовы)', () => {
      const a = createGroup('Алиса');
      const b = join(a.code, 'Борис');
      service.setSelection(a.code, a.participantId, ['5-7']);
      service.setReady(a.code, a.participantId, true);
      // Борис ещё не готов — фиксации нет, Алисе можно менять выбор
      const state = service.setSelection(a.code, a.participantId, ['5-8']);
      expect(state.participants[0]!.ready).toBe(false);
      expect(state.status).toBe('picking');
    });
  });

  describe('готовность и фиксация', () => {
    it('«Готов» без выбора — ReadyNeedsSeatsError', () => {
      const res = createGroup();
      expect(() =>
        service.setReady(res.code, res.participantId, true),
      ).toThrow(ReadyNeedsSeatsError);
    });

    it('единственный участник с выбором и готовностью — фиксация', () => {
      const res = createGroup();
      service.setSelection(res.code, res.participantId, ['5-7']);
      const state = service.setReady(res.code, res.participantId, true);
      expect(state.status).toBe('fixed');
      expect(state.conflicts).toEqual([]);
    });

    it('все готовы → fixed; смена выбора в fixed — GroupFixedError', () => {
      const a = createGroup('Алиса');
      const b = join(a.code, 'Борис');
      service.setSelection(a.code, a.participantId, ['5-7']);
      service.setSelection(a.code, b.participantId, ['5-8']);
      readyAll(a.code, [a.participantId, b.participantId]);
      const fixed = service.snapshot(a.code)!;
      expect(fixed.status).toBe('fixed');
      expect(() =>
        service.setSelection(a.code, a.participantId, ['5-9']),
      ).toThrow(GroupFixedError);
    });

    it('конфликт выборов не даёт зафиксироваться, место видно в conflicts', () => {
      const a = createGroup('Алиса');
      const b = join(a.code, 'Борис');
      service.setSelection(a.code, a.participantId, ['5-7']);
      service.setSelection(a.code, b.participantId, ['5-7', '5-8']);
      readyAll(a.code, [a.participantId, b.participantId]);
      const state = service.snapshot(a.code)!;
      expect(state.status).toBe('picking');
      expect(state.conflicts).toEqual(['5-7']);
      // Борис уступил: сменил выбор (готовность снялась сама) и снова готов
      service.setSelection(a.code, b.participantId, ['5-8']);
      service.setReady(a.code, b.participantId, true);
      expect(service.snapshot(a.code)!.status).toBe('fixed');
    });

    it('снятие готовности в fixed размораживает выбор', () => {
      const res = createGroup();
      service.setSelection(res.code, res.participantId, ['5-7']);
      service.setReady(res.code, res.participantId, true);
      expect(service.snapshot(res.code)!.status).toBe('fixed');
      const state = service.setReady(res.code, res.participantId, false);
      expect(state.status).toBe('picking');
      expect(() =>
        service.setSelection(res.code, res.participantId, ['5-9']),
      ).not.toThrow();
    });

    it('markBooked — бейдж участника', () => {
      const res = createGroup();
      service.setSelection(res.code, res.participantId, ['5-7']);
      service.setReady(res.code, res.participantId, true);
      const state = service.markBooked(res.code, res.participantId);
      expect(state.participants[0]!.booked).toBe(true);
      expect(state.status).toBe('fixed');
    });
  });

  describe('уход и распад', () => {
    it('уход участника уносит его выбор; последний — распадает группу', async () => {
      const a = createGroup('Алиса');
      const b = join(a.code, 'Борис');
      service.setSelection(a.code, b.participantId, ['5-7']);
      const afterLeave = service.leave(a.code, a.participantId);
      expect(afterLeave!.participants).toHaveLength(1);
      expect(afterLeave!.participants[0]!.name).toBe('Борис');

      const disbanded = firstValueFrom(service.disbands$.pipe(take(1)));
      expect(service.leave(a.code, b.participantId)).toBeNull();
      await expect(disbanded).resolves.toMatchObject({
        code: a.code,
        reason: 'timeout',
      });
      expect(service.snapshot(a.code)).toBeNull();
    });

    it('уход снимает блокировку фиксации: оставшийся готов — fixed', () => {
      const a = createGroup('Алиса');
      const b = join(a.code, 'Борис');
      service.setSelection(a.code, a.participantId, ['5-7']);
      service.setSelection(a.code, b.participantId, ['5-7']);
      service.setReady(a.code, a.participantId, true);
      service.leave(a.code, b.participantId);
      expect(service.snapshot(a.code)!.status).toBe('fixed');
    });

    it('таймаут без активности: ленивая экспирация при обращении', async () => {
      const res = createGroup();
      const disbanded = firstValueFrom(service.disbands$.pipe(take(1)));
      nowMs += 16 * 60_000; // idle-окно по дефолту — 15 минут
      expect(service.snapshot(res.code)).toBeNull();
      await expect(disbanded).resolves.toMatchObject({ code: res.code });
    });

    it('активность отодвигает idle-дедлайн, fixed-дедлайн — нет', () => {
      const res = createGroup();
      nowMs += 10 * 60_000;
      service.setSelection(res.code, res.participantId, ['5-7']); // touch
      nowMs += 10 * 60_000; // прошло 20 минут от создания, 10 от активности
      expect(service.snapshot(res.code)).not.toBeNull();

      service.setReady(res.code, res.participantId, true); // fixed
      nowMs += 11 * 60_000; // fixed-окно — 10 минут, активность его не продлит
      expect(service.snapshot(res.code)).toBeNull();
    });

    it('периодическая подчистка sweep распускает просроченные', async () => {
      const res = createGroup();
      const disbanded = firstValueFrom(service.disbands$.pipe(take(1)));
      nowMs += 16 * 60_000;
      (service as unknown as { sweep(): void }).sweep();
      await expect(disbanded).resolves.toMatchObject({ code: res.code });
    });
  });

  describe('sessionIdOf', () => {
    it('код группы → её сеанс (фильтр шины занятости)', () => {
      const res = createGroup('Алиса', 'session-42');
      expect(service.sessionIdOf(res.code)).toBe('session-42');
      expect(service.sessionIdOf('ZZZZZZ')).toBeNull();
    });
  });
});
