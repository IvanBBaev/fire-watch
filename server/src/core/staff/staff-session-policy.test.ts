import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  STAFF_SESSION_POLICY,
  challengeExpiry,
  decideCredentialRemoval,
  decideMemberChange,
  mayEnrollSecondFactor,
  newStaffSessionExpiries,
  slidStaffIdleExpiry,
  staffPrincipalOf,
  staffSessionState,
  usableChallenge,
  type StaffSessionFacts,
} from './staff-session-policy.js';

const AT = epochMsFromIso('2026-10-22T08:00:00Z');
const MINUTE = 60_000;

function session(overrides: Partial<StaffSessionFacts> = {}): StaffSessionFacts {
  return {
    staffId: 'a',
    roles: ['admin'],
    memberDisabled: false,
    ...newStaffSessionExpiries(AT),
    secondFactorAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('staffSessionState', () => {
  it('reads revoked before disabled before expired', () => {
    const dead = session({ revokedAt: AT, memberDisabled: true, idleExpiresAt: AT });
    expect(staffSessionState(dead, AT)).toBe('revoked');
    expect(staffSessionState({ ...dead, revokedAt: null }, AT)).toBe('member_disabled');
    expect(staffSessionState({ ...dead, revokedAt: null, memberDisabled: false }, AT)).toBe(
      'expired',
    );
  });

  it('gives a new session ten minutes to pass its second factor', () => {
    const fresh = session();
    expect(staffSessionState(fresh, AT + 10 * MINUTE - 1)).toBe('pending_second_factor');
    expect(staffSessionState(fresh, AT + 10 * MINUTE)).toBe('expired');
  });

  it('ends at the absolute expiry however recently used', () => {
    const verified = session({ secondFactorAt: AT, idleExpiresAt: AT + 12 * 60 * MINUTE });
    expect(staffSessionState(verified, AT + 12 * 60 * MINUTE - 1)).toBe('verified');
    expect(staffSessionState(verified, AT + 12 * 60 * MINUTE)).toBe('expired');
  });
});

describe('slidStaffIdleExpiry', () => {
  it('does not slide a pending session', () => {
    const pending = session();
    expect(slidStaffIdleExpiry(pending, AT + 5 * MINUTE)).toBe(pending.idleExpiresAt);
  });

  it('slides a verified session by the idle window, capped at the absolute expiry', () => {
    const verified = session({ secondFactorAt: AT });
    expect(slidStaffIdleExpiry(verified, AT + MINUTE)).toBe(
      AT + MINUTE + STAFF_SESSION_POLICY.idleMs,
    );
    const late = AT + 12 * 60 * MINUTE - MINUTE;
    expect(slidStaffIdleExpiry(verified, late)).toBe(verified.absoluteExpiresAt);
  });
});

describe('staffPrincipalOf', () => {
  it('grants powers only to a verified session', () => {
    expect(staffPrincipalOf(session(), AT).secondFactorVerified).toBe(false);
    expect(staffPrincipalOf(session({ secondFactorAt: AT }), AT).secondFactorVerified).toBe(true);
    expect(
      staffPrincipalOf(session({ secondFactorAt: AT, memberDisabled: true }), AT)
        .secondFactorVerified,
    ).toBe(false);
  });
});

describe('usableChallenge', () => {
  const stored = {
    purpose: 'webauthn.authenticate' as const,
    challenge: new Uint8Array(32),
    expiresAt: challengeExpiry(AT),
  };

  it('accepts a matching, unexpired challenge', () => {
    expect(usableChallenge(stored, 'webauthn.authenticate', AT).kind).toBe('usable');
  });

  it('refuses none, the wrong purpose and an expired one', () => {
    expect(usableChallenge(null, 'webauthn.authenticate', AT).kind).toBe('no_challenge');
    expect(usableChallenge(stored, 'webauthn.register', AT).kind).toBe('wrong_purpose');
    expect(usableChallenge(stored, 'webauthn.authenticate', stored.expiresAt).kind).toBe(
      'challenge_expired',
    );
  });
});

describe('mayEnrollSecondFactor', () => {
  it('lets a pending session enroll only the first factor', () => {
    expect(mayEnrollSecondFactor('pending_second_factor', 0)).toBe(true);
    expect(mayEnrollSecondFactor('pending_second_factor', 1)).toBe(false);
    expect(mayEnrollSecondFactor('verified', 3)).toBe(true);
    expect(mayEnrollSecondFactor('expired', 0)).toBe(false);
  });
});

describe('decideCredentialRemoval and decideMemberChange', () => {
  const admin = { staffId: 'admin', roles: ['admin'] as const, secondFactorVerified: true };
  const editor = { staffId: 'ed', roles: ['editor'] as const, secondFactorVerified: true };

  it('lets a member remove their own key and an admin anyone’s', () => {
    expect(decideCredentialRemoval(editor, 'ed').kind).toBe('allowed');
    expect(decideCredentialRemoval(admin, 'ed').kind).toBe('allowed');
    expect(decideCredentialRemoval(editor, 'other')).toEqual({
      kind: 'refused',
      reason: 'not_permitted',
    });
    expect(decideCredentialRemoval({ ...editor, secondFactorVerified: false }, 'ed')).toEqual({
      kind: 'refused',
      reason: 'second_factor_missing',
    });
  });

  it('lets an admin change another member, never themselves', () => {
    expect(decideMemberChange(admin, 'ed').kind).toBe('allowed');
    expect(decideMemberChange(admin, 'admin')).toEqual({ kind: 'refused', reason: 'self_change' });
    expect(decideMemberChange(editor, 'other')).toEqual({
      kind: 'refused',
      reason: 'not_permitted',
    });
  });
});
