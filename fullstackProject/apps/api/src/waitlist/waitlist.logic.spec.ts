import {
  ConflictException,
  GoneException,
} from '@nestjs/common';
import {
  pickNextToNotify,
  positionOf,
  waitingQueue,
  waitlistRefusalError,
} from './waitlist.logic';
import { WaitlistEntry } from './waitlist.entity';

/** запись очереди с дефолтами; переопределяется точечно */
function mk(partial: Partial<WaitlistEntry>): WaitlistEntry {
  return {
    id: 'entry-1',
    sessionId: 'session-1',
    userId: 'user-1',
    status: 'WAITING',
    queuedAt: new Date('2026-09-21T10:00:00Z'),
    notifiedAt: null,
    createdAt: new Date('2026-09-21T10:00:00Z'),
    updatedAt: new Date('2026-09-21T10:00:00Z'),
    ...partial,
  } as WaitlistEntry;
}

describe('waitingQueue', () => {
  it('оставляет только WAITING и сортирует от старейшей к новой', () => {
    const first = mk({ id: 'a', queuedAt: new Date('2026-09-21T10:00:00Z') });
    const second = mk({ id: 'b', queuedAt: new Date('2026-09-21T10:05:00Z') });
    const notified = mk({
      id: 'c',
      queuedAt: new Date('2026-09-21T09:00:00Z'),
      status: 'NOTIFIED',
    });
    const left = mk({ id: 'd', status: 'LEFT' });

    expect(waitingQueue([second, notified, first, left])).toEqual([first, second]);
  });

  it('при равном queued_at детерминирован по id', () => {
    const at = new Date('2026-09-21T10:00:00Z');
    expect(
      waitingQueue([mk({ id: 'zz' }), mk({ id: 'aa' })]).map((e) => e.id),
    ).toEqual(['aa', 'zz']);
  });
});

describe('positionOf', () => {
  it('голова — 1, дальше по порядку', () => {
    const entries = [
      mk({ id: 'newer', queuedAt: new Date('2026-09-21T10:05:00Z') }),
      mk({ id: 'head', queuedAt: new Date('2026-09-21T10:00:00Z') }),
    ];
    expect(positionOf(entries, 'head')).toBe(1);
    expect(positionOf(entries, 'newer')).toBe(2);
  });

  it('null для NOTIFIED/LEFT и незнакомой записи', () => {
    const entries = [
      mk({ id: 'waiting' }),
      mk({ id: 'notified', status: 'NOTIFIED' }),
    ];
    expect(positionOf(entries, 'notified')).toBeNull();
    expect(positionOf(entries, 'nope')).toBeNull();
  });
});

describe('pickNextToNotify', () => {
  it('старейшая WAITING', () => {
    const head = mk({ id: 'head', queuedAt: new Date('2026-09-21T10:00:00Z') });
    const tail = mk({ id: 'tail', queuedAt: new Date('2026-09-21T10:05:00Z') });
    expect(pickNextToNotify([tail, head])?.id).toBe('head');
  });

  it('null — очередь пуста или все вышли/уведомлены', () => {
    expect(pickNextToNotify([])).toBeNull();
    expect(
      pickNextToNotify([
        mk({ status: 'NOTIFIED' }),
        mk({ status: 'LEFT' }),
      ]),
    ).toBeNull();
  });
});

describe('waitlistRefusalError', () => {
  it.each([
    ['waitlistAlready', ConflictException, 409],
    ['sessionNotFull', ConflictException, 409],
    ['sessionPassed', GoneException, 410],
  ] as const)('%s — %s с кодом в теле', (code, cls, status) => {
    const err = waitlistRefusalError(code);
    expect(err).toBeInstanceOf(cls);
    expect(err.getStatus()).toBe(status);
    expect(err.getResponse()).toMatchObject({ code });
    expect(typeof (err.getResponse() as { message: string }).message).toBe(
      'string',
    );
  });
});
