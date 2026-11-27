/** demoEngine: группы «Идём вместе» — зеркало GroupsService API в памяти страницы */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import {
  MAX_PARTICIPANTS,
  MAX_SEATS_PER_PARTICIPANT,
} from '@/shared/lib/group';

/** id сеанса из сидов афиши (ленивая занятость движка) */
function firstSessionId(): string {
  return demoEngine.movies().data[0]!.sessions[0]!.id;
}

beforeEach(() => {
  demoEngine.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('demoEngine: группы «Идём вместе»', () => {
  it('создание: код, создатель-участник, превью по коду', () => {
    const sessionId = firstSessionId();
    const res = demoEngine.createGroup(sessionId, '  Алиса  ');

    expect(res.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(res.state.participants).toHaveLength(1);
    expect(res.state.participants[0]).toMatchObject({ name: 'Алиса', ready: false });
    const preview = demoEngine.groupPreview(res.code);
    expect(preview.status).toBe('picking');
    expect(preview.sessionId).toBe(sessionId);
  });

  it('превью распавшейся/чужой группы — ApiError 404', () => {
    expect(() => demoEngine.groupPreview('ZZZZZZ')).toThrow(ApiError);
  });

  it('вход новым именем и реконнект по participantId', () => {
    const sessionId = firstSessionId();
    const created = demoEngine.createGroup(sessionId, 'Алиса');
    const joined = demoEngine.groupJoin(created.code, 'Борис');
    expect(joined.state.participants).toHaveLength(2);

    const again = demoEngine.groupJoin(created.code, 'Другое имя', joined.participantId);
    expect(again.participantId).toBe(joined.participantId);
    expect(again.state.participants).toHaveLength(2);
    expect(again.state.participants.map((p) => p.name)).not.toContain('Другое имя');
  });

  it('лимит участников — отказ', () => {
    const sessionId = firstSessionId();
    const created = demoEngine.createGroup(sessionId, 'Алиса');
    for (let i = 2; i <= MAX_PARTICIPANTS; i += 1) {
      demoEngine.groupJoin(created.code, `Участник ${i}`);
    }
    expect(() => demoEngine.groupJoin(created.code, 'Девятый')).toThrow(ApiError);
  });

  it('выбор → готовность → фиксация; смена выбора снимает готовность', () => {
    const sessionId = firstSessionId();
    const a = demoEngine.createGroup(sessionId, 'Алиса');
    const b = demoEngine.groupJoin(a.code, 'Борис');

    const afterSelect = demoEngine.groupSelect(a.code, a.participantId, ['5-7']);
    expect(afterSelect.participants[0]!.seats).toEqual(['5-7']);
    expect(afterSelect.you).toBe(a.participantId);
    expect(afterSelect.occupied.length).toBeGreaterThan(0); // занятость сеанса видна

    demoEngine.groupReady(a.code, a.participantId, true);
    // смена выбора при готовности Бориса не роняет фиксацию, а Алису возвращает к выбору
    const afterChange = demoEngine.groupSelect(a.code, a.participantId, ['5-8']);
    expect(afterChange.participants[0]!.ready).toBe(false);
    expect(afterChange.status).toBe('picking');

    demoEngine.groupReady(a.code, a.participantId, true);
    const fixed = demoEngine.groupReady(b.code, b.participantId, false);
    expect(fixed.status).toBe('picking'); // Борис передумал — разморозка

    demoEngine.groupSelect(b.code, b.participantId, ['6-1']);
    demoEngine.groupReady(b.code, b.participantId, true);
    const done = demoEngine.groupRoomState(a.code, a.participantId);
    expect(done.status).toBe('fixed');
  });

  it('готовность без выбора и мусорный выбор — отказ', () => {
    const sessionId = firstSessionId();
    const a = demoEngine.createGroup(sessionId, 'Алиса');
    expect(() => demoEngine.groupReady(a.code, a.participantId, true)).toThrow(ApiError);
    expect(() =>
      demoEngine.groupSelect(a.code, a.participantId, ['9-9']),
    ).toThrow(ApiError);
    expect(() =>
      demoEngine.groupSelect(a.code, a.participantId, ['5-7', '5-7']),
    ).toThrow(ApiError);
    expect(() =>
      demoEngine.groupSelect(
        a.code,
        a.participantId,
        Array.from({ length: MAX_SEATS_PER_PARTICIPANT + 1 }, (_, i) => `1-${i + 1}`),
      ),
    ).toThrow(ApiError);
  });

  it('конфликт выборов держит группу в picking, место — в conflicts', () => {
    const sessionId = firstSessionId();
    const a = demoEngine.createGroup(sessionId, 'Алиса');
    const b = demoEngine.groupJoin(a.code, 'Борис');
    demoEngine.groupSelect(a.code, a.participantId, ['5-7']);
    demoEngine.groupSelect(b.code, b.participantId, ['5-7']);
    demoEngine.groupReady(a.code, a.participantId, true);
    const state = demoEngine.groupReady(b.code, b.participantId, true);
    expect(state.status).toBe('picking');
    expect(state.conflicts).toEqual(['5-7']);
  });

  it('«Аня»: join → выбор (не моих мест) → готовность', () => {
    const sessionId = firstSessionId();
    const a = demoEngine.createGroup(sessionId, 'Алиса');
    demoEngine.groupSelect(a.code, a.participantId, ['1-1']);

    expect(demoEngine.groupFriendStep(a.code, ['1-1'])).toBe('join');
    const withFriend = demoEngine.groupPreview(a.code);
    expect(withFriend.participants.map((p) => p.name)).toContain('Аня');

    expect(demoEngine.groupFriendStep(a.code, ['1-1'])).toBe('select');
    const friendSeats = demoEngine
      .groupPreview(a.code)
      .participants.find((p) => p.name === 'Аня')!.seats;
    expect(friendSeats.length).toBeGreaterThan(0);
    expect(friendSeats).not.toContain('1-1'); // мои места не оспаривает

    expect(demoEngine.groupFriendStep(a.code, ['1-1'])).toBe('ready');
    expect(demoEngine.groupFriendStep(a.code, ['1-1'])).toBe('none');
  });

  it('бейдж брони и уход последним — распад', () => {
    const sessionId = firstSessionId();
    const a = demoEngine.createGroup(sessionId, 'Алиса');
    demoEngine.groupSelect(a.code, a.participantId, ['5-7']);
    demoEngine.groupReady(a.code, a.participantId, true);
    const booked = demoEngine.groupBooked(a.code, a.participantId);
    expect(booked.participants[0]!.booked).toBe(true);

    expect(demoEngine.groupLeave(a.code, a.participantId)).toBeNull();
    expect(() => demoEngine.groupPreview(a.code)).toThrow(ApiError);
  });

  it('таймаут без активности — ленивый распад', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
    const sessionId = firstSessionId();
    const a = demoEngine.createGroup(sessionId, 'Алиса');
    expect(demoEngine.groupPreview(a.code).status).toBe('picking');

    vi.setSystemTime(new Date('2030-01-01T10:20:00Z')); // idle-окно истекло
    expect(() => demoEngine.groupPreview(a.code)).toThrow(ApiError);
  });

  it('активность продлевает окно, fixed-окно не продлевается', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
    const sessionId = firstSessionId();
    const a = demoEngine.createGroup(sessionId, 'Алиса');

    vi.setSystemTime(new Date('2030-01-01T10:10:00Z'));
    demoEngine.groupSelect(a.code, a.participantId, ['5-7']); // touch
    vi.setSystemTime(new Date('2030-01-01T10:20:00Z')); // 10 мин от активности
    expect(demoEngine.groupPreview(a.code).status).toBe('picking');

    demoEngine.groupReady(a.code, a.participantId, true); // fixed
    vi.setSystemTime(new Date('2030-01-01T10:35:00Z')); // fixed-окно (10 мин) вышло
    expect(() => demoEngine.groupPreview(a.code)).toThrow(ApiError);
  });
});
