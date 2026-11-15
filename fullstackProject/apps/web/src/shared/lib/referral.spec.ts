import { describe, expect, it } from 'vitest';
import { inviteLink } from './referral';

describe('inviteLink', () => {
  it('склеивает origin с hash-маршрутом регистрации и кодом', () => {
    expect(inviteLink('https://dimas1barabas.github.io', 'AB2CD3EF')).toBe(
      'https://dimas1barabas.github.io#/login?ref=AB2CD3EF',
    );
  });

  it('хвостовой слэш origin не удваивается', () => {
    expect(inviteLink('http://localhost:4173/', 'DEM0C0DE')).toBe(
      'http://localhost:4173#/login?ref=DEM0C0DE',
    );
  });

  it('код кодируется — спецсимволы не ломают query', () => {
    expect(inviteLink('https://x.dev', 'A B+C')).toBe(
      'https://x.dev#/login?ref=A%20B%2BC',
    );
  });
});
