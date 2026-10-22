/**
 * TOTP as a staff session's second factor, its removal, the wrong-code cap and member
 * off-boarding (TASKS I1, migration 030) against a real Postgres, driven through the core
 * flows with the real sealer, verifier and token issuer: a code elevates once and its
 * replay is refused, the fifth wrong code ends the session, the TOTP factor is never the
 * last one removed, and off-boarding leaves a member with nothing to sign in with — each
 * on the audit trail in its own transaction. A TOTP enrollment (migration 031) parks the
 * sealed secret in the session's challenge slot and confirms it with a code.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import type { StaffSessionStore, StaffStore } from '../../core/ports/staff-stores.js';
import { hashEntityState } from '../../core/staff/staff-audit.js';
import { STAFF_SESSION_POLICY } from '../../core/staff/staff-session-policy.js';
import {
  beginTotpEnrollment,
  finishTotpEnrollment,
  startStaffSession,
  useTotpCode,
} from '../../core/staff/staff-session.js';
import { createAesGcmTotpSealer } from '../crypto/aes-gcm-totp-sealer.js';
import { createAuthTokens } from '../crypto/auth-tokens.js';
import { createStaffRecoveryCodes, createStaffTotpCodes } from '../crypto/staff-ceremonies.js';
import { base32Decode, hotp, totpStep } from '../crypto/totp.js';
import { createPgStaffSessionStore } from './pg-staff-session-store.js';
import { createPgStaffStore, sha256Hex } from './pg-staff-store.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';

const serverDir = fileURLToPath(new URL('../../../', import.meta.url));
const dbmateBin = fileURLToPath(new URL('../../../node_modules/.bin/dbmate', import.meta.url));

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker && process.env['FIRE_WATCH_REQUIRE_DOCKER'] === '1') {
  throw new Error(
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The TOTP replay guard, ' +
      'the wrong-code cap and off-boarding only run against Postgres here; skipping is a false green.',
  );
}

const AT = epochMsFromIso('2026-10-22T08:00:00Z');
const sealer = createAesGcmTotpSealer({
  active: { id: 'staff-totp-test', key: randomBytes(32) },
  retired: [],
});

describe.skipIf(!hasDocker)('staff TOTP sign-in, removal and off-boarding', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let staff: StaffStore;
  let sessions: StaffSessionStore;
  let deps: Parameters<typeof useTotpCode>[0];
  let emailCounter = 0;

  async function newMember(roles: Parameters<StaffStore['createMember']>[0]['roles'] = ['editor']) {
    emailCounter += 1;
    const created = await staff.createMember(
      { email: `totp${String(emailCounter)}@example.org`, displayName: 'Staff', roles },
      { actorId: null, at: AT },
    );
    if (created.kind !== 'created') throw new Error('member not created');
    return created.staffId;
  }

  /** Enrolls a fresh TOTP secret and returns it, so the test can compute codes. */
  async function enrollTotp(staffId: string, codeFill = 1): Promise<Uint8Array> {
    const secret = new Uint8Array(randomBytes(20));
    await staff.enrollTotp(
      staffId,
      { sealed: sealer.seal(staffId, secret), algorithm: 'sha1' },
      [new Uint8Array(32).fill(codeFill)],
      { actorId: staffId, at: AT },
    );
    return secret;
  }

  async function pendingSession(staffId: string) {
    const started = await startStaffSession(deps, { staffId, uaFamily: 'firefox' }, { at: AT });
    if (started.kind !== 'started') throw new Error('session not started');
    const session = await sessions.findByTokenHash(
      deps.tokens.hash(started.token) ?? new Uint8Array(),
    );
    if (session === null) throw new Error('session not found');
    return session;
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const { rows } = await pool.query<{ action: string }>(
      'SELECT action FROM staff_audit_log WHERE entity_id = $1 ORDER BY id',
      [entityId],
    );
    return rows.map((r) => r.action);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    staff = createPgStaffStore(pool);
    sessions = createPgStaffSessionStore(pool);
    deps = {
      staff,
      sessions,
      tokens: createAuthTokens(),
      totp: createStaffTotpCodes(sealer, { issuer: 'Fire Watch' }),
    };
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('elevates with a TOTP code once, audits the sign-in, and refuses the replay', async () => {
    const id = await newMember();
    const secret = await enrollTotp(id);
    const code = hotp(secret, totpStep(AT));
    const first = await pendingSession(id);
    const result = await useTotpCode(deps, first, code, { at: AT, ip: '192.0.2.7' });
    expect(result.kind).toBe('verified');
    if (result.kind !== 'verified') return;
    const elevated = await sessions.findByTokenHash(
      deps.tokens.hash(result.token) ?? new Uint8Array(),
    );
    expect(elevated).toMatchObject({ secondFactorMethod: 'totp', secondFactorCredentialId: null });
    expect(await auditActions(first.id)).toEqual(['staff.sign_in']);
    expect((await staff.findTotpFactor(id))?.lastUsedStep).toBe(totpStep(AT));

    const second = await pendingSession(id);
    expect(await useTotpCode(deps, second, code, { at: AT })).toEqual({
      kind: 'refused',
      reason: 'invalid_code',
    });
    const { rows } = await pool.query<{ failures: number }>(
      'SELECT second_factor_failures AS failures FROM staff_sessions WHERE id = $1',
      [second.id],
    );
    expect(rows[0]?.failures).toBe(1);
  });

  it('lets exactly one of two sessions racing with one code elevate', async () => {
    const id = await newMember();
    const secret = await enrollTotp(id);
    const code = hotp(secret, totpStep(AT));
    const [a, b] = [await pendingSession(id), await pendingSession(id)];
    const raced = await Promise.all([
      useTotpCode(deps, a, code, { at: AT }),
      useTotpCode(deps, b, code, { at: AT }),
    ]);
    expect(raced.filter((r) => r.kind === 'verified')).toHaveLength(1);
  });

  it('ends the session on the last allowed wrong code and audits why', async () => {
    const id = await newMember();
    await enrollTotp(id);
    const session = await pendingSession(id);
    const max = STAFF_SESSION_POLICY.maxSecondFactorFailures;
    // A typo is not a guess: a malformed code is not counted.
    expect(await useTotpCode(deps, session, '12', { at: AT })).toEqual({
      kind: 'refused',
      reason: 'invalid_code',
    });
    const results = [];
    for (let i = 0; i < max; i++) {
      // Two different wrong codes cannot both match one step, so at most one could be right.
      results.push(await useTotpCode(deps, session, i % 2 === 0 ? '000000' : '999999', { at: AT }));
    }
    const reasons = results.map((r) => (r.kind === 'refused' ? r.reason : r.kind));
    expect(reasons.at(-1)).toBe('session_ended');
    expect(reasons.slice(0, -1).every((r) => r === 'invalid_code' || r === 'verified')).toBe(true);
    const { rows } = await pool.query<{ revoked: boolean; failures: number }>(
      `SELECT revoked_at IS NOT NULL AS revoked, second_factor_failures AS failures
       FROM staff_sessions WHERE id = $1`,
      [session.id],
    );
    if (reasons.includes('verified')) return; // a 1-in-10^6 hit: the cap was not exercised.
    expect(rows[0]).toEqual({ revoked: true, failures: max });
    expect(await auditActions(session.id)).toEqual(['staff.sign_out']);
    const { rows: after } = await pool.query<{ after_hash: string }>(
      "SELECT after_hash FROM staff_audit_log WHERE entity_id = $1 AND action = 'staff.sign_out'",
      [session.id],
    );
    expect(after[0]?.after_hash).toBe(
      hashEntityState({ reason: 'too_many_second_factor_failures', failures: max }, sha256Hex),
    );
    // A revoked session is not counted against any more.
    expect(await sessions.recordSecondFactorFailure(session.id, max, { at: AT })).toBeNull();
  });

  it('removes TOTP only beside another factor, ending the sessions it signed', async () => {
    const id = await newMember();
    const secret = await enrollTotp(id);
    expect(await staff.removeTotpFactor(id, { actorId: id, at: AT })).toEqual({
      kind: 'last_second_factor',
    });
    await staff.enrollWebAuthnCredential(
      id,
      {
        credentialId: new Uint8Array(34).fill(0x30),
        publicKeyCose: new Uint8Array(77).fill(0xa5),
        algorithm: -7,
        signCount: 0,
        backupEligible: false,
        label: 'Backup key',
      },
      null,
      { actorId: id, at: AT },
    );
    const session = await pendingSession(id);
    const verified = await useTotpCode(deps, session, hotp(secret, totpStep(AT)), { at: AT });
    expect(verified.kind).toBe('verified');

    expect(await staff.removeTotpFactor(id, { actorId: id, at: AT + 1 })).toEqual({
      kind: 'removed',
      sessionsRevoked: 1,
    });
    expect(await staff.findTotpFactor(id)).toBeNull();
    expect(await staff.countSecondFactors(id)).toBe(1);
    expect(await staff.removeTotpFactor(id, { actorId: id, at: AT + 2 })).toEqual({
      kind: 'not_found',
    });
    expect(await auditActions(id)).toContain('staff.second_factor_removed');
  });

  it('off-boards a member: nothing left to sign in with, and a repeat is a no-op', async () => {
    const admin = await newMember(['admin']);
    const id = await newMember(['editor', 'moderator']);
    await enrollTotp(id, 9);
    const live = await pendingSession(id);
    const done = await staff.offboardMember(id, { actorId: admin, at: AT, ip: '192.0.2.8' });
    expect(done).toEqual({
      kind: 'offboarded',
      wasLive: true,
      sessionsRevoked: 1,
      webauthnRemoved: 0,
      totpRemoved: 1,
      recoveryCodesRemoved: 1,
      rolesRemoved: ['editor', 'moderator'],
    });
    expect(await staff.findMember(id)).toMatchObject({ disabled: true, roles: [] });
    expect(await staff.countSecondFactors(id)).toBe(0);
    const { rows: revoked } = await pool.query<{ revoked: boolean }>(
      'SELECT revoked_at IS NOT NULL AS revoked FROM staff_sessions WHERE id = $1',
      [live.id],
    );
    expect(revoked).toEqual([{ revoked: true }]);
    expect(await staff.offboardMember(id, { actorId: admin, at: AT + 1 })).toEqual({
      kind: 'already_offboarded',
    });
    const manage = (await auditActions(id)).filter((a) => a === 'staff.manage');
    // createMember's row plus exactly one off-boarding row.
    expect(manage).toHaveLength(2);
    expect(
      await staff.offboardMember('00000000-0000-4000-8000-000000000000', {
        actorId: admin,
        at: AT,
      }),
    ).toEqual({ kind: 'not_found' });
  });

  it('enrolls TOTP through the challenge slot and signs in with it afterwards', async () => {
    const id = await newMember();
    const enrollDeps = { ...deps, recoveryCodes: createStaffRecoveryCodes() };
    const session = await pendingSession(id);
    const begun = await beginTotpEnrollment(enrollDeps, session, AT);
    if (begun.kind !== 'secret') throw new Error('no secret issued');
    const { rows: parked } = await pool.query<{ purpose: string; key_id: string; len: number }>(
      `SELECT challenge_purpose AS purpose, challenge_key_id AS key_id,
              octet_length(challenge) AS len
       FROM staff_sessions WHERE id = $1`,
      [session.id],
    );
    expect(parked).toEqual([{ purpose: 'totp.enroll', key_id: 'staff-totp-test', len: 48 }]);
    const secret = base32Decode(begun.secret);
    if (secret === null) throw new Error('secret is not base32');

    expect(
      await finishTotpEnrollment(enrollDeps, session, hotp(secret, totpStep(AT) + 10), {
        at: AT + 1000,
      }),
    ).toMatchObject({ kind: 'refused' });
    const done = await finishTotpEnrollment(enrollDeps, session, hotp(secret, totpStep(AT)), {
      at: AT + 1000,
    });
    expect(done.kind).toBe('enrolled');
    if (done.kind !== 'enrolled') return;
    expect(done.recoveryCodes).toHaveLength(10);
    expect(done.token).not.toBeNull();

    const { rows: cleared } = await pool.query(
      `SELECT challenge, challenge_purpose, challenge_key_id FROM staff_sessions WHERE id = $1`,
      [session.id],
    );
    expect(cleared).toEqual([{ challenge: null, challenge_purpose: null, challenge_key_id: null }]);
    expect(await auditActions(id)).toContain('staff.second_factor_enrolled');
    // The confirming code is burnt; the next step's code signs in.
    const next = await pendingSession(id);
    expect(
      (await useTotpCode(deps, next, hotp(secret, totpStep(AT)), { at: AT + 2000 })).kind,
    ).toBe('refused');
    const later = AT + 30_000;
    const again = await pendingSession(id);
    expect(
      (await useTotpCode(deps, again, hotp(secret, totpStep(later)), { at: later })).kind,
    ).toBe('verified');
  });

  it('refuses a TOTP key id on a WebAuthn challenge, and a TOTP challenge without one', async () => {
    const id = await newMember();
    const session = await pendingSession(id);
    await expect(
      pool.query(
        `UPDATE staff_sessions SET challenge = $2, challenge_purpose = 'webauthn.register',
           challenge_expires_at = now(), challenge_key_id = 'k1' WHERE id = $1`,
        [session.id, Buffer.alloc(32)],
      ),
    ).rejects.toThrow(/staff_sessions_challenge_key_id_iff_totp/);
    await expect(
      pool.query(
        `UPDATE staff_sessions SET challenge = $2, challenge_purpose = 'totp.enroll',
           challenge_expires_at = now() WHERE id = $1`,
        [session.id, Buffer.alloc(48)],
      ),
    ).rejects.toThrow(/staff_sessions_challenge_key_id_iff_totp/);
  });
});
