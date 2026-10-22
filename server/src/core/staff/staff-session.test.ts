import { describe, expect, it } from 'vitest';

import type { AuthTokens } from '../ports/auth-stores.js';
import { epochMsFromIso } from '../ports/clock.js';
import type {
  StaffRecoveryCodes,
  StaffSessionStore,
  StaffStore,
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
  removeWebAuthnCredential,
  startStaffSession,
  useRecoveryCode,
  type StaffSessionDeps,
} from './staff-session.js';
import type { StoredChallenge } from './staff-session-policy.js';

const AT = epochMsFromIso('2026-10-22T08:00:00Z');
const STAFF = 'staff-1';
const KEY = new Uint8Array([7, 7, 7]);

/** In-memory fakes with just enough behaviour to drive the flows. */
function world(options: { factors?: number; credential?: boolean; assertion?: boolean } = {}) {
  let tokenSeq = 0;
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
      if (s === undefined || s.secondFactorAt !== null) return Promise.resolve(false);
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
  const deps: StaffSessionDeps = {
    sessions: sessionStore,
    staff,
    tokens,
    ceremonies,
    recoveryCodes,
  };
  return { deps, calls, sessions };
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
    expect(calls).toEqual(['markSecondFactor:recovery_code']);
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
});
