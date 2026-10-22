/**
 * The staff session's rules, as pure functions (TASKS I1; 05 C3, §5.4.3; migration 029).
 *
 * 05 gives the staff plane its own session namespace and makes 2FA mandatory; it does not
 * give numbers. The windows below are this module's defaults, chosen to be tighter than a
 * member of the public's 30-day sliding session (§5.4.1) because a staff session can
 * publish to the incident log and approve broadcasts:
 *
 *   * a session that has not passed its second factor within ten minutes is dead — the
 *     "signed in, 2FA pending" state has no powers (`staffMay`) and should not linger;
 *   * a verified session slides its idle expiry by thirty minutes on use, but never past
 *     an absolute twelve hours from sign-in — a working day, then sign in again;
 *   * a WebAuthn challenge is good for five minutes (WebAuthn §5.4's recommended
 *     ceremony timeout range is 5–10 minutes) and is answered at most once;
 *   * five wrong TOTP or recovery codes end a pending session (migration 030): a six-digit
 *     code with a ±1 step window is a 1-in-333,333 guess, so five tries in a ten-minute
 *     window keep a guesser near 1 in 66,000 per sign-in, which the primary sign-in's
 *     own rate limit then multiplies (NIST SP 800-63B §5.2.2 asks for a cap of 100 or
 *     fewer).
 *
 * Who may remove a credential and change a member are decisions here too, so the HTTP
 * plane (L-15) and any CLI apply the same rule.
 */

import type { EpochMs } from '../ports/clock.js';
import { staffMay, type StaffPrincipal, type StaffRole } from './staff-policy.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const STAFF_SESSION_POLICY = {
  secondFactorWindowMs: 10 * MINUTE_MS,
  idleMs: 30 * MINUTE_MS,
  absoluteMs: 12 * HOUR_MS,
  challengeTtlMs: 5 * MINUTE_MS,
  maxSecondFactorFailures: 5,
} as const;

export const STAFF_SECOND_FACTOR_METHODS = ['webauthn', 'totp', 'recovery_code'] as const;
export type StaffSecondFactorMethod = (typeof STAFF_SECOND_FACTOR_METHODS)[number];

export const STAFF_CHALLENGE_PURPOSES = ['webauthn.register', 'webauthn.authenticate'] as const;
export type StaffChallengePurpose = (typeof STAFF_CHALLENGE_PURPOSES)[number];

/** What the rules read from a stored session. */
export interface StaffSessionFacts {
  readonly staffId: string;
  readonly roles: readonly StaffRole[];
  readonly memberDisabled: boolean;
  readonly idleExpiresAt: EpochMs;
  readonly absoluteExpiresAt: EpochMs;
  readonly secondFactorAt: EpochMs | null;
  readonly revokedAt: EpochMs | null;
}

export type StaffSessionState =
  'revoked' | 'member_disabled' | 'expired' | 'pending_second_factor' | 'verified';

export function staffSessionState(session: StaffSessionFacts, at: EpochMs): StaffSessionState {
  if (session.revokedAt !== null) return 'revoked';
  if (session.memberDisabled) return 'member_disabled';
  if (at >= session.idleExpiresAt || at >= session.absoluteExpiresAt) return 'expired';
  return session.secondFactorAt === null ? 'pending_second_factor' : 'verified';
}

/** A new session's expiries: the pending window, inside the absolute one. */
export function newStaffSessionExpiries(at: EpochMs): {
  readonly idleExpiresAt: EpochMs;
  readonly absoluteExpiresAt: EpochMs;
} {
  return {
    idleExpiresAt: at + STAFF_SESSION_POLICY.secondFactorWindowMs,
    absoluteExpiresAt: at + STAFF_SESSION_POLICY.absoluteMs,
  };
}

/**
 * The idle expiry after a use at `at`, never past the absolute one. A pending session does
 * not slide: its window is the second-factor window from sign-in, however often it calls.
 */
export function slidStaffIdleExpiry(
  session: Pick<StaffSessionFacts, 'secondFactorAt' | 'idleExpiresAt' | 'absoluteExpiresAt'>,
  at: EpochMs,
): EpochMs {
  if (session.secondFactorAt === null) return session.idleExpiresAt;
  return Math.min(at + STAFF_SESSION_POLICY.idleMs, session.absoluteExpiresAt);
}

/** The principal the permission table reads; powers only once the second factor passed. */
export function staffPrincipalOf(session: StaffSessionFacts, at: EpochMs): StaffPrincipal {
  return {
    staffId: session.staffId,
    roles: session.roles,
    secondFactorVerified: staffSessionState(session, at) === 'verified',
  };
}

export interface StoredChallenge {
  readonly purpose: StaffChallengePurpose;
  readonly challenge: Uint8Array;
  readonly expiresAt: EpochMs;
}

export function challengeExpiry(at: EpochMs): EpochMs {
  return at + STAFF_SESSION_POLICY.challengeTtlMs;
}

export type ChallengeRefusal = 'no_challenge' | 'wrong_purpose' | 'challenge_expired';

/** The challenge a finishing ceremony may check against, or why there is none. */
export function usableChallenge(
  taken: StoredChallenge | null,
  purpose: StaffChallengePurpose,
  at: EpochMs,
):
  | { readonly kind: 'usable'; readonly challenge: Uint8Array }
  | { readonly kind: ChallengeRefusal } {
  if (taken === null) return { kind: 'no_challenge' };
  if (taken.purpose !== purpose) return { kind: 'wrong_purpose' };
  if (at >= taken.expiresAt) return { kind: 'challenge_expired' };
  return { kind: 'usable', challenge: taken.challenge };
}

/**
 * Enrolling a factor needs a verified session — except the very first one: a member with
 * no second factor at all enrolls it from the pending session, and that enrollment is
 * what verifies the session. Anyone else adding a key must prove the factor they have.
 */
export function mayEnrollSecondFactor(
  state: StaffSessionState,
  existingSecondFactors: number,
): boolean {
  if (state === 'verified') return true;
  return state === 'pending_second_factor' && existingSecondFactors === 0;
}

export type StaffChangeDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'refused';
      readonly reason: 'second_factor_missing' | 'not_permitted' | 'self_change';
    };

/**
 * Removing a WebAuthn credential: its own member, or an admin (`staff.manage`), both past
 * their second factor. The store separately refuses a removal that would leave a live
 * member with no second factor — a lost sole key is replaced by signing in with a recovery
 * code, enrolling a new key, then removing the lost one.
 */
export function decideCredentialRemoval(
  actor: StaffPrincipal,
  targetStaffId: string,
): StaffChangeDecision {
  if (!actor.secondFactorVerified) return { kind: 'refused', reason: 'second_factor_missing' };
  if (actor.staffId === targetStaffId || staffMay(actor, 'staff.manage')) {
    return { kind: 'allowed' };
  }
  return { kind: 'refused', reason: 'not_permitted' };
}

/**
 * Disabling a member or changing their roles: `staff.manage`, never on oneself — an admin
 * cannot lock out or demote the session they are acting from, so the plane cannot lose its
 * last admin by a slip; a second admin does it.
 */
export function decideMemberChange(
  actor: StaffPrincipal,
  targetStaffId: string,
): StaffChangeDecision {
  if (!actor.secondFactorVerified) return { kind: 'refused', reason: 'second_factor_missing' };
  if (!staffMay(actor, 'staff.manage')) return { kind: 'refused', reason: 'not_permitted' };
  if (actor.staffId === targetStaffId) return { kind: 'refused', reason: 'self_change' };
  return { kind: 'allowed' };
}
