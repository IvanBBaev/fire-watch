import { describe, expect, it } from 'vitest';

import type { AuthTokens } from '../ports/auth-stores.js';
import { epochMsFromIso } from '../ports/clock.js';
import type {
  StaffRecoveryCodes,
  StaffSessionStore,
  StaffStore,
  StaffTotpCodes,
  StaffWebAuthnCeremonies,
  StoredStaffSession,
  StoredWebAuthnCredential,
} from '../ports/staff-stores.js';
import {
  authenticateStaffSession,
  beginWebAuthn,
  disableStaffMember,
  finishWebAuthnAssertion,
  finishWebAuthnRegistration,
  offboardStaffMember,
  removeStaffTotpFactor,
  removeWebAuthnCredential,
  startStaffSession,
  useRecoveryCode,
  useTotpCode,
  type StaffSessionDeps,
} from './staff-session.js';
import { STAFF_SESSION_POLICY, type StoredChallenge } from './staff-session-policy.js';

const AT = epochMsFromIso('2026-10-22T08:00:00Z');
const STAFF = 'staff-1';
const KEY = new Uint8Array([7, 7, 7]);

/** In-memory fakes with just enough behaviour to drive the flows. */
function world(
  options: { factors?: number; credential?: boolean; assertion?: boolean; totp?: boolean } = {},
) {
  let tokenSeq = 0;
  let lastTotpStep: number | null = null;
  const failures = new Map<string, number>();
  const sessions = new Map<string, StoredStaffSession & { tokenHash: string }>();
  const challenges = new Map<string, StoredChallenge>();
  const credentials: StoredWebAuthnCredential[] =
    options.credential === false
      ? []
      : [
          {
            credentialId: KEY,
            staffId: STAFF,
            publicKeyCose: new Uint8Array(32),
            algorithm: -7,
            signCount: 1,
            backupEligible: false,
            label: 'key',
            enrolledAt: AT,
            lastUsedAt: null,
          },
        ];
  const calls: string[] = [];
  const hex = (bytes: Uint8Array) => [...bytes].join(',');
  const tokens: AuthTokens = {
    mint() {
      tokenSeq += 1;
      const token = `token-${tokenSeq}`;
      return { token, hash: new TextEncoder().encode(token.padEnd(32, '.')) };
    },
    hash: (token) => new TextEncoder().encode(token.padEnd(32, '.')),
    newId: () => `session-${sessions.size + 1}`,
  };
  const sessionStore: StaffSessionStore = {
    insert(s) {
      sessions.set(s.id, {
        id: s.id,
        staffId: s.staffId,
        uaFamily: s.uaFamily,
        roles: ['admin'],
        memberDisabled: false,
        createdAt: s.at,
        lastSeenAt: s.at,
        idleExpiresAt: s.idleExpiresAt,
        absoluteExpiresAt: s.absoluteExpiresAt,
        secondFactorAt: null,
        secondFactorMethod: null,
        secondFactorCredentialId: null,
        revokedAt: null,
        tokenHash: hex(s.tokenHash),
      });
      return Promise.resolve();
    },
    findByTokenHash: (hash) =>
      Promise.resolve([...sessions.values()].find((s) => s.tokenHash === hex(hash)) ?? null),
    touch: (id) => Promise.resolve(sessions.get(id)?.revokedAt === null),
    putChallenge(id, challenge) {
      challenges.set(id, challenge);
      return Promise.resolve(true);
    },
    takeChallenge(id) {
      const taken = challenges.get(id) ?? null;
      challenges.delete(id);
      return Promise.resolve(taken);
    },
    markSecondFactor(id, input, context) {
      const s = sessions.get(id);
      if (s === undefined || s.secondFactorAt !== null || s.revokedAt !== null) {
        return Promise.resolve(false);
      }
      sessions.set(id, {
        ...s,
        secondFactorAt: context.at,
        secondFactorMethod: input.method,
        secondFactorCredentialId: input.credentialId,
        idleExpiresAt: input.idleExpiresAt,
        tokenHash: hex(input.newTokenHash),
      });
      calls.push(`markSecondFactor:${input.method}`);
      return Promise.resolve(true);
    },
    recordSecondFactorFailure(id, limit) {
      const s = sessions.get(id);
      if (s === undefined || s.revokedAt !== null || s.secondFactorAt !== null) {
        return Promise.resolve(null);
      }
      const count = (failures.get(id) ?? 0) + 1;
      failures.set(id, count);
      const revoked = count >= limit;
      if (revoked) sessions.set(id, { ...s, revokedAt: AT });
      calls.push(`failure:${count}`);
      return Promise.resolve({ failures: count, revoked });
    },
    revoke: () => Promise.resolve(true),
  };
  const staff = {
    findMember: (staffId: string) =>
      Promise.resolve(
        staffId === STAFF
          ? { staffId, email: 'a@example.org', displayName: 'A', roles: [], disabled: false }
          : null,
      ),
    countSecondFactors: () => Promise.resolve(options.factors ?? credentials.length),
    listWebAuthnCredentials: () => Promise.resolve(credentials),
    findWebAuthnCredential: (id: Uint8Array) =>
      Promise.resolve(credentials.find((c) => hex(c.credentialId) === hex(id)) ?? null),
    advanceWebAuthnSignCount: (_id: Uint8Array, count: number) => {
      calls.push(`advance:${count}`);
      return Promise.resolve(true);
    },
    enrollWebAuthnCredential: (
      _staffId: string,
      _credential: unknown,
      codes: readonly Uint8Array[] | null,
    ) => {
      calls.push(`enroll:${codes === null ? 'no-codes' : codes.length}`);
      return Promise.resolve({ kind: 'enrolled' as const });
    },
    consumeRecoveryCode: (_staffId: string, hash: Uint8Array) =>
      Promise.resolve(hex(hash) === hex(new Uint8Array(32).fill(9))),
    removeWebAuthnCredential: () => {
      calls.push('remove');
      return Promise.resolve({ kind: 'removed' as const, sessionsRevoked: 1 });
    },
    findTotpFactor: () =>
      Promise.resolve(
        options.totp === true
          ? {
              sealed: { ciphertext: new Uint8Array(48), keyId: 'k1' },
              algorithm: 'sha1' as const,
              lastUsedStep: lastTotpStep,
            }
          : null,
      ),
    advanceTotpStep: (_staffId: string, step: number) => {
      if (lastTotpStep !== null && step <= lastTotpStep) return Promise.resolve(false);
      lastTotpStep = step;
      calls.push(`advanceTotp:${step}`);
      return Promise.resolve(true);
    },
    removeTotpFactor: () => {
      calls.push('removeTotp');
      return Promise.resolve({ kind: 'removed' as const, sessionsRevoked: 1 });
    },
    offboardMember: (staffId: string) => {
      calls.push('offboard');
      return Promise.resolve(
        staffId === 'gone'
          ? { kind: 'not_found' as const }
          : {
              kind: 'offboarded' as const,
              wasLive: true,
              sessionsRevoked: 1,
              webauthnRemoved: 1,
              totpRemoved: 0,
              recoveryCodesRemoved: 10,
              rolesRemoved: ['admin'],
            },
      );
    },
    disableMember: () => {
      calls.push('disable');
      return Promise.resolve({ kind: 'disabled' as const, sessionsRevoked: 2 });
    },
  } as unknown as StaffStore;
  const ceremonies: StaffWebAuthnCeremonies = {
    challenge: () => new Uint8Array(32).fill(1),
    verifyRegistration: () => ({
      kind: 'accepted',
      credential: {
        credentialId: new Uint8Array([8]),
        publicKeyCose: new Uint8Array(32),
        algorithm: -7,
        signCount: 0,
        backupEligible: true,
      },
    }),
    verifyAssertion: () =>
      options.assertion === false
        ? { kind: 'refused', reason: 'bad_signature' }
        : { kind: 'accepted', signCount: 2 },
  };
  const recoveryCodes: StaffRecoveryCodes = {
    issue: () => [{ display: 'AAAA-BBBB', hash: new Uint8Array(32) }],
    hash: (raw) =>
      raw === 'good' ? new Uint8Array(32).fill(9) : raw === 'bad' ? null : new Uint8Array(32),
  };
  // A stand-in for the sealed verifier: '123456' is the current step (100), '000000' an
  // older one, '111111' a replayed one; anything else of six digits is wrong.
  const totp: StaffTotpCodes = {
    verify({ code, factor }) {
      if (!/^\d{6}$/.test(code)) return { kind: 'refused', reason: 'malformed' };
      if (code === '111111') return { kind: 'refused', reason: 'replayed' };
      const step = code === '123456' ? 100 : code === '000000' ? 99 : null;
      if (step === null) return { kind: 'refused', reason: 'wrong_code' };
      if (factor.lastUsedStep !== null && step <= factor.lastUsedStep) {
        return { kind: 'refused', reason: 'replayed' };
      }
      return { kind: 'accepted', step };
    },
  };
  const deps: StaffSessionDeps = {
    sessions: sessionStore,
    staff,
    tokens,
    ceremonies,
    recoveryCodes,
  };
  return { deps, calls, sessions, totp };
}

async function pendingSession(deps: StaffSessionDeps): Promise<StoredStaffSession> {
  const started = await startStaffSession(
    deps,
    { staffId: STAFF, uaFamily: 'firefox' },
    { at: AT },
  );
  if (started.kind !== 'started') throw new Error('not started');
  const auth = await authenticateStaffSession(deps, started.token, AT);
  if (auth.kind !== 'authenticated') throw new Error('not authenticated');
  expect(auth.state).toBe('pending_second_factor');
  expect(auth.principal.secondFactorVerified).toBe(false);
  return auth.session;
}

const assertion = {
  credentialId: KEY,
  clientDataJSON: new Uint8Array(1),
  authenticatorData: new Uint8Array(1),
  signature: new Uint8Array(1),
};

describe('staff session flows', () => {
  it('refuses to start a session for an unknown member', async () => {
    const { deps } = world();
    expect(await startStaffSession(deps, { staffId: 'nobody', uaFamily: 'x' }, { at: AT })).toEqual(
      { kind: 'member_unavailable' },
    );
  });

  it('elevates a pending session with a WebAuthn assertion and rotates the token', async () => {
    const { deps, calls } = world();
    const session = await pendingSession(deps);
    const begun = await beginWebAuthn(deps, session, 'webauthn.authenticate', AT);
    expect(begun.kind).toBe('challenge');
    const finished = await finishWebAuthnAssertion(deps, session, assertion, { at: AT + 1 });
    expect(finished).toEqual({ kind: 'verified', token: 'token-2' });
    expect(calls).toEqual(['advance:2', 'markSecondFactor:webauthn']);
    expect((await authenticateStaffSession(deps, 'token-1', AT + 2)).kind).toBe('unauthenticated');
    const after = await authenticateStaffSession(deps, 'token-2', AT + 2);
    expect(after.kind === 'authenticated' && after.principal.secondFactorVerified).toBe(true);
  });

  it('answers a challenge once', async () => {
    const { deps } = world({ assertion: false });
    const session = await pendingSession(deps);
    await beginWebAuthn(deps, session, 'webauthn.authenticate', AT);
    expect(await finishWebAuthnAssertion(deps, session, assertion, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'ceremony_refused',
    });
    expect(await finishWebAuthnAssertion(deps, session, assertion, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'no_challenge',
    });
  });

  it('refuses an expired challenge and one issued for registration', async () => {
    const { deps } = world();
    const session = await pendingSession(deps);
    await beginWebAuthn(deps, session, 'webauthn.authenticate', AT);
    expect(
      await finishWebAuthnAssertion(deps, session, assertion, { at: AT + 5 * 60_000 }),
    ).toEqual({ kind: 'refused', reason: 'challenge_expired' });
    const fresh = world({ factors: 0, credential: false });
    const pending = await pendingSession(fresh.deps);
    await beginWebAuthn(fresh.deps, pending, 'webauthn.register', AT);
    expect(await finishWebAuthnAssertion(fresh.deps, pending, assertion, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'wrong_purpose',
    });
  });

  it("refuses another member's credential", async () => {
    const { deps } = world();
    const session = await pendingSession(deps);
    await beginWebAuthn(deps, session, 'webauthn.authenticate', AT);
    const other = { ...assertion, credentialId: new Uint8Array([1]) };
    expect(await finishWebAuthnAssertion(deps, session, other, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'unknown_credential',
    });
  });

  it('enrolls the first key from a pending session, prints codes and elevates', async () => {
    const { deps, calls } = world({ factors: 0, credential: false });
    const session = await pendingSession(deps);
    expect((await beginWebAuthn(deps, session, 'webauthn.register', AT)).kind).toBe('challenge');
    const result = await finishWebAuthnRegistration(
      deps,
      session,
      { clientDataJSON: new Uint8Array(1), attestationObject: new Uint8Array(1), label: ' key ' },
      { at: AT },
    );
    expect(result).toEqual({ kind: 'enrolled', recoveryCodes: ['AAAA-BBBB'], token: 'token-2' });
    expect(calls).toEqual(['enroll:1', 'markSecondFactor:webauthn']);
  });

  it('does not let a pending session add a second key', async () => {
    const { deps } = world({ factors: 1 });
    const session = await pendingSession(deps);
    expect(await beginWebAuthn(deps, session, 'webauthn.register', AT)).toEqual({
      kind: 'refused',
      reason: 'not_allowed',
    });
  });

  it('elevates with a recovery code and refuses a bad one', async () => {
    const { deps, calls } = world();
    const session = await pendingSession(deps);
    expect(await useRecoveryCode(deps, session, 'bad', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'invalid_code',
    });
    expect(await useRecoveryCode(deps, session, 'unknown', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'invalid_code',
    });
    expect(await useRecoveryCode(deps, session, 'good', { at: AT })).toEqual({
      kind: 'verified',
      token: 'token-2',
    });
    // 'bad' cannot be a code (not counted); 'unknown' could be a guess (counted).
    expect(calls).toEqual(['failure:1', 'markSecondFactor:recovery_code']);
  });

  it('applies the policy before removing a key or disabling a member', async () => {
    const { deps, calls } = world();
    const pending = { staffId: STAFF, roles: ['admin'] as const, secondFactorVerified: false };
    expect(
      await removeWebAuthnCredential(
        deps,
        pending,
        { staffId: STAFF, credentialId: KEY },
        { at: AT },
      ),
    ).toEqual({ kind: 'refused', reason: 'second_factor_missing' });
    const admin = { ...pending, secondFactorVerified: true };
    expect(await disableStaffMember(deps, admin, STAFF, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'self_change',
    });
    expect(calls).toEqual([]);
    expect(await disableStaffMember(deps, admin, 'staff-2', { at: AT })).toEqual({
      kind: 'disabled',
      sessionsRevoked: 2,
    });
    expect(
      await removeWebAuthnCredential(
        deps,
        admin,
        { staffId: STAFF, credentialId: KEY },
        { at: AT },
      ),
    ).toEqual({ kind: 'removed', sessionsRevoked: 1 });
  });

  it('elevates with a TOTP code, advances the step and refuses its replay', async () => {
    const { deps, calls, totp } = world({ totp: true });
    const session = await pendingSession(deps);
    expect(await useTotpCode({ ...deps, totp }, session, '123456', { at: AT })).toEqual({
      kind: 'verified',
      token: 'token-2',
    });
    expect(calls).toEqual(['advanceTotp:100', 'markSecondFactor:totp']);
    const second = await pendingSession(deps);
    expect(await useTotpCode({ ...deps, totp }, second, '123456', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'invalid_code',
    });
    expect(calls.slice(2)).toEqual(['failure:1']);
  });

  it('refuses a TOTP code when the step CAS loses the race', async () => {
    const { deps, calls, totp } = world({ totp: true });
    const session = await pendingSession(deps);
    // The verifier saw the stale step; the store already holds 100.
    await deps.staff.advanceTotpStep(STAFF, 100);
    const stale = { verify: () => ({ kind: 'accepted' as const, step: 100 }) };
    expect(await useTotpCode({ ...deps, totp: stale }, session, '123456', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'invalid_code',
    });
    expect(calls).toEqual(['advanceTotp:100', 'failure:1']);
    expect(await useTotpCode({ ...deps, totp }, session, '999999', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'invalid_code',
    });
  });

  it('refuses TOTP to a member without the factor and to a verified session', async () => {
    const without = world();
    const pending = await pendingSession(without.deps);
    expect(
      await useTotpCode({ ...without.deps, totp: without.totp }, pending, '123456', { at: AT }),
    ).toEqual({ kind: 'refused', reason: 'not_allowed' });
    const { deps, totp } = world({ totp: true });
    const session = await pendingSession(deps);
    await useTotpCode({ ...deps, totp }, session, '123456', { at: AT });
    const verified = { ...session, secondFactorAt: AT, secondFactorMethod: 'totp' as const };
    expect(await useTotpCode({ ...deps, totp }, verified, '000000', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'not_allowed',
    });
  });

  it('does not count a malformed code but ends the session at the failure cap', async () => {
    const { deps, calls, totp } = world({ totp: true });
    const session = await pendingSession(deps);
    expect(await useTotpCode({ ...deps, totp }, session, '12ab', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'invalid_code',
    });
    expect(calls).toEqual([]);
    const cap = STAFF_SESSION_POLICY.maxSecondFactorFailures;
    for (let attempt = 1; attempt < cap; attempt++) {
      expect(await useTotpCode({ ...deps, totp }, session, '999999', { at: AT })).toEqual({
        kind: 'refused',
        reason: 'invalid_code',
      });
    }
    // Recovery-code guesses count against the same session.
    expect(await useRecoveryCode(deps, session, 'unknown', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'session_ended',
    });
    expect(calls).toHaveLength(cap);
    expect(await useTotpCode({ ...deps, totp }, session, '123456', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'session_ended',
    });
  });

  it('applies the policy before removing the TOTP factor or off-boarding a member', async () => {
    const { deps, calls } = world();
    const pending = { staffId: STAFF, roles: ['admin'] as const, secondFactorVerified: false };
    expect(await removeStaffTotpFactor(deps, pending, { staffId: STAFF }, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'second_factor_missing',
    });
    const editor = { staffId: STAFF, roles: ['editor'] as const, secondFactorVerified: true };
    expect(await removeStaffTotpFactor(deps, editor, { staffId: 'staff-2' }, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'not_permitted',
    });
    expect(await offboardStaffMember(deps, editor, 'staff-2', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'not_permitted',
    });
    const admin = { ...pending, secondFactorVerified: true };
    expect(await offboardStaffMember(deps, admin, STAFF, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'self_change',
    });
    expect(calls).toEqual([]);
    expect(await removeStaffTotpFactor(deps, editor, { staffId: STAFF }, { at: AT })).toEqual({
      kind: 'removed',
      sessionsRevoked: 1,
    });
    expect(await offboardStaffMember(deps, admin, 'gone', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'not_found',
    });
    expect((await offboardStaffMember(deps, admin, 'staff-2', { at: AT })).kind).toBe('offboarded');
    expect(calls).toEqual(['removeTotp', 'offboard', 'offboard']);
  });
});
