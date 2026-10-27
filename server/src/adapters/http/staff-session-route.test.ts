/**
 * The staff session routes over in-memory fakes of the staff stores (TASKS I1). The flows
 * themselves are `staff-session.test.ts`'s; these tests pin the HTTP side — the cookie
 * rotating on elevation and clearing on a dead session, the refusal codes, `no-store` and
 * the Origin check.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthTokens } from '../../core/ports/auth-stores.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type {
  StaffRecoveryCodes,
  StaffSessionStore,
  StaffStore,
  StaffTotpCodes,
  StaffWebAuthnCeremonies,
  StoredStaffSession,
} from '../../core/ports/staff-stores.js';
import { startStaffSession } from '../../core/staff/staff-session.js';
import type { StoredChallenge } from '../../core/staff/staff-session-policy.js';
import {
  registerStaffSessionRoutes,
  STAFF_SESSION_PATH,
  staffSessionCookieNamed,
} from './staff-session-route.js';

const ORIGIN = 'https://staff.fire-watch.example';
const STAFF = '00000000-0000-4000-8000-000000000001';
const COOKIE = 'fw_staff';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/**
 * A member with a TOTP factor ('123456' is the current code) and a passkey (id `[7]`)
 * whose ceremony the fake never accepts.
 */
async function build() {
  const clock = new VirtualClock('2026-10-27T08:00:00Z');
  let tokenSeq = 0;
  let lastStep: number | null = null;
  const sessions = new Map<string, StoredStaffSession & { tokenHash: string }>();
  const challenges = new Map<string, StoredChallenge>();
  const revoked: string[] = [];
  const hex = (bytes: Uint8Array) => [...bytes].join(',');
  const encode = (token: string) => new TextEncoder().encode(token.padEnd(32, '.'));
  const tokens: AuthTokens = {
    mint() {
      tokenSeq += 1;
      const token = `token-${tokenSeq}`;
      return { token, hash: encode(token) };
    },
    hash: encode,
    newId: () => `session-${sessions.size + 1}`,
  };
  const live = (s: StoredStaffSession | undefined) => s !== undefined && s.revokedAt === null;
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
    touch: (id) => Promise.resolve(live(sessions.get(id))),
    putChallenge(id, challenge) {
      challenges.set(id, challenge);
      return Promise.resolve(live(sessions.get(id)));
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
      return Promise.resolve(true);
    },
    recordSecondFactorFailure: () => Promise.resolve({ failures: 1, revoked: false }),
    revoke(id, context) {
      const s = sessions.get(id);
      if (s === undefined || s.revokedAt !== null) return Promise.resolve(false);
      sessions.set(id, { ...s, revokedAt: context.at });
      revoked.push(id);
      return Promise.resolve(true);
    },
  };
  const staff = {
    findMember: (staffId: string) =>
      Promise.resolve(
        staffId === STAFF
          ? { staffId, email: 'a@example.org', displayName: 'A', roles: [], disabled: false }
          : null,
      ),
    countSecondFactors: () => Promise.resolve(2),
    listWebAuthnCredentials: () => Promise.resolve([{ credentialId: new Uint8Array([7]) }]),
    // Any other id is unknown; `[7]` fails its ceremony.
    findWebAuthnCredential: (id: Uint8Array) =>
      Promise.resolve(
        hex(id) === '7'
          ? {
              credentialId: id,
              staffId: STAFF,
              publicKeyCose: new Uint8Array(32),
              algorithm: -7,
              signCount: 1,
              backupEligible: false,
              label: 'key',
              enrolledAt: 0,
              lastUsedAt: null,
            }
          : null,
      ),
    findTotpFactor: () =>
      Promise.resolve({
        sealed: { ciphertext: new Uint8Array(48), keyId: 'k1' },
        algorithm: 'sha1' as const,
        lastUsedStep: lastStep,
      }),
    advanceTotpStep: (_staffId: string, step: number) => {
      if (lastStep !== null && step <= lastStep) return Promise.resolve(false);
      lastStep = step;
      return Promise.resolve(true);
    },
  } as unknown as StaffStore;
  const ceremonies: StaffWebAuthnCeremonies = {
    challenge: () => new Uint8Array(32).fill(1),
    verifyRegistration: () => ({ kind: 'refused', reason: 'bad_attestation' }),
    verifyAssertion: () => ({ kind: 'refused', reason: 'bad_signature' }),
  } as unknown as StaffWebAuthnCeremonies;
  const recoveryCodes: StaffRecoveryCodes = {
    issue: () => [{ display: 'AAAA-BBBB', hash: new Uint8Array(32) }],
    hash: () => null,
  };
  const totp: StaffTotpCodes = {
    issue: () => {
      throw new Error('not in these tests');
    },
    verify({ code, factor }) {
      if (code !== '123456') return { kind: 'refused', reason: 'wrong_code' };
      if (factor.lastUsedStep !== null && factor.lastUsedStep >= 100) {
        return { kind: 'refused', reason: 'replayed' };
      }
      return { kind: 'accepted', step: 100 };
    },
  };
  const deps = { sessions: sessionStore, staff, tokens, ceremonies, recoveryCodes };
  const app = Fastify({ logger: false });
  apps.push(app);
  registerStaffSessionRoutes(app, {
    ...deps,
    totp,
    cookie: staffSessionCookieNamed(COOKIE),
    allowedOrigins: [ORIGIN],
    clock,
  });
  const started = await startStaffSession(
    deps,
    { staffId: STAFF, uaFamily: 'firefox' },
    { at: clock.now() },
  );
  if (started.kind !== 'started') throw new Error('not started');
  const call = (
    token: string | null,
    method: 'GET' | 'POST',
    path: string,
    payload?: object,
    origin: string = ORIGIN,
  ) =>
    app.inject({
      method,
      url: `${STAFF_SESSION_PATH}${path}`,
      headers: { origin, ...(token === null ? {} : { cookie: `${COOKIE}=${token}` }) },
      ...(payload === undefined ? {} : { payload }),
    });
  return { call, token: started.token, sessions, challenges, revoked, clock };
}

/** The response's single `Set-Cookie`, failing on none or several. */
function setCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  expect(typeof header, `one set-cookie, got ${JSON.stringify(header)}`).toBe('string');
  return header as string;
}

const tokenOf = (cookie: string) => /^fw_staff=([^;]*);/.exec(cookie)?.[1];

describe('staff session routes', () => {
  it('reads a pending session, then elevates it with a TOTP code and rotates the cookie', async () => {
    const { call, token } = await build();
    const before = await call(token, 'GET', '');
    expect(before.statusCode).toBe(200);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(before.json()).toMatchObject({
      state: 'pending_second_factor',
      staff_id: STAFF,
      roles: ['admin'],
      second_factor_method: null,
    });
    expect(tokenOf(setCookie(before))).toBe(token);

    const elevated = await call(token, 'POST', '/totp', { code: '123456' });
    expect(elevated.statusCode).toBe(200);
    expect(elevated.json()).toEqual({ state: 'verified' });
    const cookie = setCookie(elevated);
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict; Path=/');
    expect(cookie).toMatch(/Max-Age=1800$/);
    const rotated = tokenOf(cookie);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(token);

    const old = await call(token, 'GET', '');
    expect(old.statusCode).toBe(401);
    const after = await call(rotated ?? '', 'GET', '');
    expect(after.json()).toMatchObject({ state: 'verified', second_factor_method: 'totp' });
  });

  it('refuses a wrong code without ending the session', async () => {
    const { call, token } = await build();
    const wrong = await call(token, 'POST', '/totp', { code: '654321' });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({ code: 'staff_code_invalid' });
    expect((await call(token, 'GET', '')).statusCode).toBe(200);
  });

  it('refuses a malformed body before touching the session', async () => {
    const { call, token } = await build();
    const response = await call(token, 'POST', '/webauthn/challenge', { purpose: 'other' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_body' });
    const bytes = await call(token, 'POST', '/webauthn/assertion', {
      credential_id: 'not base64url!',
      client_data_json: 'AA',
      authenticator_data: 'AA',
      signature: 'AA',
    });
    expect(bytes.statusCode).toBe(400);
  });

  it('runs the passkey challenge, mapping each refusal to its code', async () => {
    const { call, token, challenges } = await build();
    // A pending member who already holds a factor proves it; they do not add another.
    const register = await call(token, 'POST', '/webauthn/challenge', { purpose: 'register' });
    expect(register.statusCode).toBe(403);
    expect(register.json()).toMatchObject({ code: 'staff_forbidden' });

    const assertion = {
      credential_id: 'Bw',
      client_data_json: 'AA',
      authenticator_data: 'AA',
      signature: 'AA',
    };
    const early = await call(token, 'POST', '/webauthn/assertion', assertion);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'staff_challenge_unusable' });

    const begun = await call(token, 'POST', '/webauthn/challenge', { purpose: 'authenticate' });
    expect(begun.statusCode).toBe(200);
    expect(begun.json()).toEqual({
      challenge: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
      credential_ids: ['Bw'],
      timeout_ms: 300_000,
    });
    expect(challenges.size).toBe(1);

    const refused = await call(token, 'POST', '/webauthn/assertion', assertion);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'staff_second_factor_refused' });
    expect(challenges.size).toBe(0);

    // An unknown key reads the same as a bad signature: nothing for a guesser.
    await call(token, 'POST', '/webauthn/challenge', { purpose: 'authenticate' });
    const unknown = await call(token, 'POST', '/webauthn/assertion', {
      ...assertion,
      credential_id: 'CA',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ code: 'staff_second_factor_refused' });
  });

  it('answers a missing, unknown or revoked session with 401 and a cleared cookie', async () => {
    const { call, token, sessions } = await build();
    for (const who of [null, 'token-unknown']) {
      const response = await call(who, 'GET', '');
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'not_signed_in' });
      expect(setCookie(response)).toMatch(/^fw_staff=; .*Max-Age=0$/);
    }
    const [id] = sessions.keys();
    const row = sessions.get(id ?? '');
    if (row === undefined) throw new Error('no session');
    sessions.set(row.id, { ...row, revokedAt: row.createdAt });
    const dead = await call(token, 'POST', '/totp', { code: '123456' });
    expect(dead.statusCode).toBe(401);
    expect(setCookie(dead)).toContain('Max-Age=0');
  });

  it('signs out: revokes the session, clears the cookie, and is idempotent', async () => {
    const { call, token, revoked } = await build();
    const out = await call(token, 'POST', '/sign-out');
    expect(out.statusCode).toBe(204);
    expect(out.headers['cache-control']).toBe('no-store');
    expect(setCookie(out)).toContain('Max-Age=0');
    expect(revoked).toHaveLength(1);
    expect((await call(token, 'GET', '')).statusCode).toBe(401);
    const again = await call(token, 'POST', '/sign-out');
    expect(again.statusCode).toBe(204);
    expect(revoked).toHaveLength(1);
  });

  it('refuses a foreign Origin', async () => {
    const { call, token } = await build();
    const response = await call(token, 'POST', '/totp', { code: '123456' }, 'https://evil.example');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'origin_refused' });
  });
});

describe('staffSessionCookieNamed', () => {
  it('reads the first matching pair and refuses a name that is not a token', () => {
    const cookie = staffSessionCookieNamed('__Host-fw_staff');
    expect(cookie.read('a=1; __Host-fw_staff=t1; __Host-fw_staff=t2')).toBe('t1');
    expect(cookie.read('__Host-fw_staff=')).toBeUndefined();
    expect(cookie.read(undefined)).toBeUndefined();
    expect(cookie.set('t', 90_000, 0)).toBe(
      '__Host-fw_staff=t; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=90',
    );
    expect(() => staffSessionCookieNamed('a;b')).toThrow();
  });
});
