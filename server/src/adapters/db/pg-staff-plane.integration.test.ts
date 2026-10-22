/**
 * The staff plane's storage (TASKS I1, migration 026) against a real Postgres: a TOTP step
 * is accepted once even when two requests race with it, a recovery code is spent once and
 * re-enrollment voids the old set, disabling a member locks their second factor, every
 * write lands on the audit trail in its transaction, and the incident log's versions are a
 * compare-and-set whose published rows 026 freezes and whose open version is unique.
 * WebAuthn credentials (027) are unique across the plane, and their signature counter is a
 * compare-and-set too, so a racing or replayed assertion cannot advance it twice.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import { runCurationRehearsal } from '../../core/staff/curation-rehearsal.js';
import type { StaffSessionStore, StaffStore } from '../../core/ports/staff-stores.js';
import type { IncidentEntryVersion } from '../../core/staff/incident-log-workflow.js';
import { hashEntityState } from '../../core/staff/staff-audit.js';
import {
  challengeExpiry,
  newStaffSessionExpiries,
  staffSessionState,
} from '../../core/staff/staff-session-policy.js';
import { auditedState, createPgIncidentLogStore } from './pg-incident-log-store.js';
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
    "FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The staff plane's replay " +
      'guards are only ever executed against Postgres here, so skipping them in CI is a false green.',
  );
}

const AT = epochMsFromIso('2026-10-22T08:00:00Z');
const SEALED = { ciphertext: new Uint8Array(48).fill(7), keyId: 'staff-totp-2026-10' };

function codeHash(n: number): Uint8Array {
  return new Uint8Array(32).fill(n);
}

describe.skipIf(!hasDocker)('staff plane storage', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let staff: StaffStore;
  let emailCounter = 0;

  async function newMember(roles: Parameters<StaffStore['createMember']>[0]['roles'] = ['editor']) {
    emailCounter += 1;
    const created = await staff.createMember(
      { email: `staff${String(emailCounter)}@example.org`, displayName: 'Staff', roles },
      { actorId: null, at: AT },
    );
    if (created.kind !== 'created') throw new Error('member not created');
    return created.staffId;
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
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('creates a member with roles, refuses a second with the same email, and audits once', async () => {
    const created = await staff.createMember(
      { email: 'lead@example.org', displayName: 'Lead', roles: ['admin', 'editor'] },
      { actorId: null, ip: '192.0.2.10', at: AT },
    );
    if (created.kind !== 'created') throw new Error('expected a new member');
    expect(await staff.findMember(created.staffId)).toEqual({
      staffId: created.staffId,
      email: 'lead@example.org',
      displayName: 'Lead',
      roles: ['admin', 'editor'],
      disabled: false,
    });
    const again = await staff.createMember(
      { email: 'lead@example.org', displayName: 'Other', roles: [] },
      { actorId: created.staffId, at: AT },
    );
    expect(again).toEqual({ kind: 'email_taken' });
    expect(await auditActions(created.staffId)).toEqual(['staff.manage']);
    const { rows } = await pool.query<{ actor_id: string; ip: string }>(
      'SELECT actor_id::text, host(ip) AS ip FROM staff_audit_log WHERE entity_id = $1',
      [created.staffId],
    );
    expect(rows).toEqual([{ actor_id: created.staffId, ip: '192.0.2.10' }]);
  });

  it('refuses an email that is not lower case', async () => {
    await expect(
      staff.createMember(
        { email: 'Mixed@Example.org', displayName: 'M', roles: [] },
        { actorId: null, at: AT },
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('accepts each TOTP step once, in order, and exactly once under a race', async () => {
    const id = await newMember();
    await staff.enrollTotp(id, { sealed: SEALED, algorithm: 'sha1' }, [codeHash(1)], {
      actorId: id,
      at: AT,
    });
    expect((await staff.findTotpFactor(id))?.lastUsedStep).toBeNull();

    expect(await staff.advanceTotpStep(id, 100)).toBe(true);
    expect(await staff.advanceTotpStep(id, 100)).toBe(false);
    expect(await staff.advanceTotpStep(id, 99)).toBe(false);

    const raced = await Promise.all(
      Array.from({ length: 4 }, () => staff.advanceTotpStep(id, 101)),
    );
    expect(raced.filter(Boolean)).toHaveLength(1);
    expect((await staff.findTotpFactor(id))?.lastUsedStep).toBe(101);
  });

  it('round-trips the sealed secret as bytes', async () => {
    const id = await newMember();
    await staff.enrollTotp(id, { sealed: SEALED, algorithm: 'sha256' }, [], {
      actorId: id,
      at: AT,
    });
    expect(await staff.findTotpFactor(id)).toEqual({
      sealed: SEALED,
      algorithm: 'sha256',
      lastUsedStep: null,
    });
  });

  it('spends a recovery code once, and re-enrollment voids the old set and the step', async () => {
    const id = await newMember();
    await staff.enrollTotp(id, { sealed: SEALED, algorithm: 'sha1' }, [codeHash(1), codeHash(2)], {
      actorId: id,
      at: AT,
    });
    await staff.advanceTotpStep(id, 500);

    expect(await staff.consumeRecoveryCode(id, codeHash(1), { at: AT })).toBe(true);
    expect(await staff.consumeRecoveryCode(id, codeHash(1), { at: AT })).toBe(false);
    expect(await staff.consumeRecoveryCode(id, codeHash(9), { at: AT })).toBe(false);

    await staff.enrollTotp(id, { sealed: SEALED, algorithm: 'sha1' }, [codeHash(3)], {
      actorId: id,
      at: AT,
    });
    expect(await staff.consumeRecoveryCode(id, codeHash(2), { at: AT })).toBe(false);
    expect(await staff.consumeRecoveryCode(id, codeHash(3), { at: AT })).toBe(true);
    expect((await staff.findTotpFactor(id))?.lastUsedStep).toBeNull();

    expect(await auditActions(id)).toEqual([
      'staff.manage',
      'staff.second_factor_enrolled',
      'staff.recovery_code_used',
      'staff.second_factor_enrolled',
      'staff.recovery_code_used',
    ]);
  });

  it('locks a disabled member out of every second-factor path', async () => {
    const id = await newMember();
    await staff.enrollTotp(id, { sealed: SEALED, algorithm: 'sha1' }, [codeHash(4)], {
      actorId: id,
      at: AT,
    });
    await pool.query('UPDATE staff_members SET disabled_at = now() WHERE id = $1', [id]);

    expect(await staff.findTotpFactor(id)).toBeNull();
    expect(await staff.advanceTotpStep(id, 1)).toBe(false);
    expect(await staff.consumeRecoveryCode(id, codeHash(4), { at: AT })).toBe(false);
    await expect(
      staff.enrollTotp(id, { sealed: SEALED, algorithm: 'sha1' }, [], { actorId: id, at: AT }),
    ).rejects.toThrow(/disabled/);
    expect((await staff.findMember(id))?.disabled).toBe(true);
  });

  describe('WebAuthn credentials (migration 027)', () => {
    let keyCounter = 0;
    function credential(signCount = 0) {
      keyCounter += 1;
      return {
        credentialId: new Uint8Array(32).fill(keyCounter),
        publicKeyCose: new Uint8Array(77).fill(0xa5),
        algorithm: -7 as const,
        signCount,
        backupEligible: false,
        label: `Key ${String(keyCounter)}`,
      };
    }

    it('enrolls keys, refuses a credential id already held, and audits only the win', async () => {
      const a = await newMember();
      const b = await newMember();
      const key = credential(5);
      expect(
        await staff.enrollWebAuthnCredential(a, key, [codeHash(9)], { actorId: a, at: AT }),
      ).toEqual({ kind: 'enrolled' });
      expect(
        await staff.enrollWebAuthnCredential(b, key, [codeHash(10)], { actorId: b, at: AT }),
      ).toEqual({ kind: 'credential_taken' });
      expect(await auditActions(b)).toEqual(['staff.manage']);
      // The losing enrollment left b's (empty) codes alone.
      expect(await staff.consumeRecoveryCode(b, codeHash(10), { at: AT })).toBe(false);
      expect(await staff.consumeRecoveryCode(a, codeHash(9), { at: AT })).toBe(true);

      const found = await staff.findWebAuthnCredential(key.credentialId);
      expect(found).toMatchObject({ staffId: a, signCount: 5, algorithm: -7, lastUsedAt: null });
      expect(found?.publicKeyCose).toEqual(key.publicKeyCose);
      await staff.enrollWebAuthnCredential(a, credential(), null, { actorId: a, at: AT });
      expect((await staff.listWebAuthnCredentials(a)).map((c) => c.label)).toHaveLength(2);
      expect(await auditActions(a)).toEqual([
        'staff.manage',
        'staff.second_factor_enrolled',
        'staff.recovery_code_used',
        'staff.second_factor_enrolled',
      ]);
    });

    it('lets exactly one of two racing assertions advance the counter', async () => {
      const id = await newMember();
      const key = credential(7);
      await staff.enrollWebAuthnCredential(id, key, null, { actorId: id, at: AT });
      const results = await Promise.all([
        staff.advanceWebAuthnSignCount(key.credentialId, 8, AT + 1000),
        staff.advanceWebAuthnSignCount(key.credentialId, 8, AT + 1000),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await staff.advanceWebAuthnSignCount(key.credentialId, 8, AT + 2000)).toBe(false);
      expect(await staff.advanceWebAuthnSignCount(key.credentialId, 3, AT + 2000)).toBe(false);
      expect(await staff.findWebAuthnCredential(key.credentialId)).toMatchObject({
        signCount: 8,
        lastUsedAt: AT + 1000,
      });
    });

    it('keeps accepting a passkey whose counter stays at zero', async () => {
      const id = await newMember();
      const key = credential(0);
      await staff.enrollWebAuthnCredential(id, key, null, { actorId: id, at: AT });
      expect(await staff.advanceWebAuthnSignCount(key.credentialId, 0, AT + 1)).toBe(true);
      expect(await staff.advanceWebAuthnSignCount(key.credentialId, 0, AT + 2)).toBe(true);
    });

    it('locks a disabled member out of their keys', async () => {
      const id = await newMember();
      const key = credential(1);
      await staff.enrollWebAuthnCredential(id, key, null, { actorId: id, at: AT });
      await pool.query('UPDATE staff_members SET disabled_at = now() WHERE id = $1', [id]);
      expect(await staff.findWebAuthnCredential(key.credentialId)).toBeNull();
      expect(await staff.listWebAuthnCredentials(id)).toEqual([]);
      expect(await staff.advanceWebAuthnSignCount(key.credentialId, 2, AT)).toBe(false);
      await expect(
        staff.enrollWebAuthnCredential(id, credential(), null, { actorId: id, at: AT }),
      ).rejects.toThrow(/disabled/);
    });

    it('refuses an algorithm the verifier does not accept', async () => {
      const id = await newMember();
      await expect(
        pool.query(
          `INSERT INTO staff_webauthn_credentials
             (credential_id, staff_id, public_key_cose, algorithm, sign_count, backup_eligible,
              label, enrolled_at)
           VALUES ($1, $2, $3, -35, 0, false, 'k', now())`,
          [Buffer.alloc(16, 0xee), id, Buffer.alloc(77, 1)],
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  describe('staff sessions and credential removal (migration 029)', () => {
    let sessions: StaffSessionStore;
    let seq = 0;
    beforeAll(() => {
      sessions = createPgStaffSessionStore(pool);
    });

    function key() {
      seq += 1;
      return {
        // 33 bytes, so never equal to the 32-byte ids the WebAuthn tests use.
        credentialId: new Uint8Array(33).fill(seq),
        publicKeyCose: new Uint8Array(77).fill(0xa5),
        algorithm: -7 as const,
        signCount: 0,
        backupEligible: false,
        label: `Session key ${String(seq)}`,
      };
    }

    function tokenHash(): Uint8Array {
      seq += 1;
      return new Uint8Array(32).fill(seq).map((byte, index) => (index === 0 ? 0x29 : byte));
    }

    async function newSession(staffId: string) {
      const { rows } = await pool.query<{ id: string }>('SELECT gen_random_uuid()::text AS id');
      const id = rows[0]?.id ?? '';
      const hash = tokenHash();
      await sessions.insert({
        id,
        tokenHash: hash,
        staffId,
        uaFamily: 'firefox',
        at: AT,
        ...newStaffSessionExpiries(AT),
      });
      return { id, hash };
    }

    const challenge = (fill: number) => ({
      purpose: 'webauthn.authenticate' as const,
      challenge: new Uint8Array(32).fill(fill),
      expiresAt: challengeExpiry(AT),
    });

    it('reads a session with its live roles, and slides only within the absolute expiry', async () => {
      const id = await newMember(['editor', 'admin']);
      const s = await newSession(id);
      const found = await sessions.findByTokenHash(s.hash);
      expect(found).toMatchObject({
        id: s.id,
        staffId: id,
        roles: ['admin', 'editor'],
        memberDisabled: false,
        secondFactorAt: null,
        secondFactorMethod: null,
        revokedAt: null,
      });
      expect(found && staffSessionState(found, AT)).toBe('pending_second_factor');
      expect(await sessions.touch(s.id, AT + 1000, AT + 10 ** 12)).toBe(true);
      expect((await sessions.findByTokenHash(s.hash))?.idleExpiresAt).toBe(
        found?.absoluteExpiresAt,
      );
    });

    it('hands a challenge to exactly one of two racing takers', async () => {
      const id = await newMember();
      const s = await newSession(id);
      expect(await sessions.putChallenge(s.id, challenge(1), AT)).toBe(true);
      // A second put replaces the first: one pending challenge per session.
      expect(await sessions.putChallenge(s.id, challenge(2), AT)).toBe(true);
      const taken = await Promise.all([sessions.takeChallenge(s.id), sessions.takeChallenge(s.id)]);
      const won = taken.filter((t) => t !== null);
      expect(won).toHaveLength(1);
      expect(won[0]?.challenge).toEqual(new Uint8Array(32).fill(2));
      expect(won[0]?.purpose).toBe('webauthn.authenticate');
      expect(await sessions.takeChallenge(s.id)).toBeNull();
      // No challenge on an expired or revoked session.
      expect(await sessions.putChallenge(s.id, challenge(3), AT + 10 * 60_000)).toBe(false);
      await sessions.revoke(s.id, { at: AT });
      expect(await sessions.putChallenge(s.id, challenge(3), AT)).toBe(false);
    });

    it('elevates once, swaps the token and audits the sign-in in the same transaction', async () => {
      const id = await newMember();
      const k = key();
      await staff.enrollWebAuthnCredential(id, k, null, { actorId: id, at: AT });
      const s = await newSession(id);
      const newHashes = [tokenHash(), tokenHash()];
      const results = await Promise.all(
        newHashes.map((newTokenHash) =>
          sessions.markSecondFactor(
            s.id,
            {
              method: 'webauthn',
              credentialId: k.credentialId,
              newTokenHash,
              idleExpiresAt: AT + 60_000,
            },
            { at: AT + 1000, ip: '192.0.2.9' },
          ),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await sessions.findByTokenHash(s.hash)).toBeNull();
      const winner = results[0] === true ? newHashes[0] : newHashes[1];
      const elevated = await sessions.findByTokenHash(winner ?? new Uint8Array());
      expect(elevated).toMatchObject({
        secondFactorMethod: 'webauthn',
        secondFactorAt: AT + 1000,
        idleExpiresAt: AT + 60_000,
      });
      expect(elevated?.secondFactorCredentialId).toEqual(k.credentialId);
      expect(await auditActions(s.id)).toEqual(['staff.sign_in']);
      expect(await sessions.revoke(s.id, { at: AT + 2000 })).toBe(true);
      expect(await sessions.revoke(s.id, { at: AT + 2000 })).toBe(false);
      expect(await auditActions(s.id)).toEqual(['staff.sign_in', 'staff.sign_out']);
    });

    it("refuses to elevate with another member's key or after expiry", async () => {
      const a = await newMember();
      const b = await newMember();
      const k = key();
      await staff.enrollWebAuthnCredential(b, k, null, { actorId: b, at: AT });
      const s = await newSession(a);
      const input = {
        method: 'webauthn' as const,
        credentialId: k.credentialId,
        newTokenHash: tokenHash(),
        idleExpiresAt: AT + 60_000,
      };
      expect(await sessions.markSecondFactor(s.id, input, { at: AT })).toBe(false);
      const late = { ...input, method: 'recovery_code' as const, credentialId: null };
      expect(await sessions.markSecondFactor(s.id, late, { at: AT + 10 * 60_000 })).toBe(false);
      expect(await auditActions(s.id)).toEqual([]);
    });

    it('removes a key, ends the sessions it let in, and never the last factor', async () => {
      const id = await newMember();
      const first = key();
      const second = key();
      await staff.enrollWebAuthnCredential(id, first, null, { actorId: id, at: AT });
      await staff.enrollWebAuthnCredential(id, second, null, { actorId: id, at: AT });
      expect(await staff.countSecondFactors(id)).toBe(2);
      const viaFirst = await newSession(id);
      const viaSecond = await newSession(id);
      for (const [s, k] of [
        [viaFirst, first],
        [viaSecond, second],
      ] as const) {
        await sessions.markSecondFactor(
          s.id,
          {
            method: 'webauthn',
            credentialId: k.credentialId,
            newTokenHash: tokenHash(),
            idleExpiresAt: AT + 60_000,
          },
          { at: AT },
        );
      }
      const other = await newMember();
      expect(
        await staff.removeWebAuthnCredential(other, first.credentialId, { actorId: other, at: AT }),
      ).toEqual({ kind: 'not_found' });

      // Two racing removals of the member's two keys: the row lock lets exactly one through.
      const raced = await Promise.all([
        staff.removeWebAuthnCredential(id, first.credentialId, { actorId: id, at: AT + 1 }),
        staff.removeWebAuthnCredential(id, second.credentialId, { actorId: id, at: AT + 1 }),
      ]);
      expect(raced.map((r) => r.kind).sort()).toEqual(['last_second_factor', 'removed']);
      expect(raced.find((r) => r.kind === 'removed')).toEqual({
        kind: 'removed',
        sessionsRevoked: 1,
      });
      expect(await staff.countSecondFactors(id)).toBe(1);
      const { rows } = await pool.query<{ id: string; revoked: boolean }>(
        'SELECT id::text AS id, revoked_at IS NOT NULL AS revoked FROM staff_sessions WHERE staff_id = $1',
        [id],
      );
      expect(rows.filter((r) => r.revoked)).toHaveLength(1);
      expect(await auditActions(id)).toContain('staff.second_factor_removed');
    });

    it('disables a member and ends every session of theirs', async () => {
      const admin = await newMember(['admin']);
      const id = await newMember(['editor']);
      const a = await newSession(id);
      const b = await newSession(id);
      expect(await staff.disableMember(id, { actorId: admin, at: AT + 1 })).toEqual({
        kind: 'disabled',
        sessionsRevoked: 2,
      });
      expect(await staff.disableMember(id, { actorId: admin, at: AT + 1 })).toEqual({
        kind: 'not_found',
      });
      for (const s of [a, b]) {
        expect((await sessions.findByTokenHash(s.hash))?.revokedAt).toBe(AT + 1);
      }
      expect(await staff.countSecondFactors(id)).toBe(0);
    });

    it('replaces a role set and audits only a change', async () => {
      const admin = await newMember(['admin']);
      const id = await newMember(['editor', 'moderator']);
      expect(await staff.setRoles(id, ['admin', 'editor'], { actorId: admin, at: AT })).toEqual({
        kind: 'changed',
      });
      expect((await staff.findMember(id))?.roles).toEqual(['admin', 'editor']);
      expect(await staff.setRoles(id, ['editor', 'admin'], { actorId: admin, at: AT })).toEqual({
        kind: 'unchanged',
      });
      expect(await auditActions(id)).toEqual(['staff.manage', 'staff.manage']);
    });
  });

  describe('incident log', () => {
    const v = (
      entryId: string,
      version: number,
      status: IncidentEntryVersion['status'],
      contributorIds: readonly string[],
    ): IncidentEntryVersion => ({
      entryId,
      version,
      status,
      contributorIds,
      triggersNotifications: false,
      major: false,
    });

    async function newEntryId(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>('SELECT gen_random_uuid()::text AS id');
      return rows[0]?.id ?? '';
    }

    it('walks draft → review → published → revision, with the trail re-hashable', async () => {
      const log = createPgIncidentLogStore(pool);
      const editor = await newMember(['editor']);
      const reviewer = await newMember(['editor']);
      const entry = await newEntryId();
      const content = { title: 'Feed outage', body: 'FIRMS was late by 3 h.' };

      expect(
        await log.write({
          expected: null,
          next: v(entry, 1, 'draft', [editor]),
          content,
          action: 'incident.edit',
          context: { actorId: editor, at: AT },
        }),
      ).toEqual({ kind: 'written' });
      expect(
        await log.write({
          expected: { version: 1, status: 'draft', editSeq: 0 },
          next: v(entry, 1, 'in_review', [editor]),
          action: 'incident.submit',
          context: { actorId: editor, at: AT },
        }),
      ).toEqual({ kind: 'written' });
      const published = v(entry, 1, 'published', [editor]);
      expect(
        await log.write({
          expected: { version: 1, status: 'in_review', editSeq: 1 },
          next: published,
          action: 'incident.publish',
          context: { actorId: reviewer, at: AT + 60_000 },
        }),
      ).toEqual({ kind: 'written' });

      const history = await log.listPublished(entry);
      expect(history).toHaveLength(1);
      expect(history[0]?.version).toEqual(published);
      expect(history[0]?.content).toEqual(content);
      expect(history[0]?.publishedAt).toBe(AT + 60_000);

      // A reader can re-hash what the public page shows and find it on the trail.
      const { rows } = await pool.query<{ after_hash: string }>(
        "SELECT after_hash FROM staff_audit_log WHERE entity_id = $1 AND action = 'incident.publish'",
        [entry],
      );
      expect(rows[0]?.after_hash).toBe(
        hashEntityState(auditedState(published, content), sha256Hex),
      );

      const revised = { ...content, body: 'FIRMS was late by 4 h.' };
      expect(
        await log.write({
          expected: { version: 1, status: 'published', editSeq: 2 },
          next: v(entry, 2, 'draft', [reviewer]),
          content: revised,
          action: 'incident.edit',
          context: { actorId: reviewer, at: AT + 120_000 },
        }),
      ).toEqual({ kind: 'written' });
      const latest = await log.findLatest(entry);
      expect(latest?.version).toEqual(v(entry, 2, 'draft', [reviewer]));
      expect(latest?.content).toEqual(revised);
      expect((await log.listPublished(entry)).map((p) => p.content)).toEqual([content]);

      expect(await auditActions(entry)).toEqual([
        'incident.edit',
        'incident.submit',
        'incident.publish',
        'incident.edit',
      ]);
    });

    it('lets exactly one of two racing writes from the same version win', async () => {
      const log = createPgIncidentLogStore(pool);
      const a = await newMember();
      const b = await newMember();
      const entry = await newEntryId();
      await log.write({
        expected: null,
        next: v(entry, 1, 'draft', [a]),
        content: { t: 'x' },
        action: 'incident.edit',
        context: { actorId: a, at: AT },
      });

      const results = await Promise.all([
        log.write({
          expected: { version: 1, status: 'draft', editSeq: 0 },
          next: v(entry, 1, 'in_review', [a]),
          action: 'incident.submit',
          context: { actorId: a, at: AT },
        }),
        log.write({
          expected: { version: 1, status: 'draft', editSeq: 0 },
          next: v(entry, 1, 'draft', [a, b]),
          content: { t: 'y' },
          action: 'incident.edit',
          context: { actorId: b, at: AT },
        }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(['conflict', 'written']);
      expect(await auditActions(entry)).toHaveLength(2);
    });

    it('refuses a submit decided from a draft that was edited since', async () => {
      const log = createPgIncidentLogStore(pool);
      const a = await newMember();
      const b = await newMember();
      const entry = await newEntryId();
      await log.write({
        expected: null,
        next: v(entry, 1, 'draft', [a]),
        content: { t: 'x' },
        action: 'incident.edit',
        context: { actorId: a, at: AT },
      });
      const seen = await log.findLatest(entry);
      expect(seen?.editSeq).toBe(0);

      expect(
        await log.write({
          expected: { version: 1, status: 'draft', editSeq: 0 },
          next: v(entry, 1, 'draft', [a, b]),
          content: { t: 'y' },
          action: 'incident.edit',
          context: { actorId: b, at: AT },
        }),
      ).toEqual({ kind: 'written' });
      expect((await log.findLatest(entry))?.editSeq).toBe(1);

      // Same number, same status — only the counter tells the submitter the text moved.
      expect(
        await log.write({
          expected: { version: 1, status: 'draft', editSeq: 0 },
          next: v(entry, 1, 'in_review', [a]),
          action: 'incident.submit',
          context: { actorId: a, at: AT },
        }),
      ).toEqual({ kind: 'conflict' });
      expect((await log.findLatest(entry))?.version.status).toBe('draft');
      expect(await auditActions(entry)).toEqual(['incident.edit', 'incident.edit']);
    });

    it('keeps contributors in first-touch order as they accumulate', async () => {
      const log = createPgIncidentLogStore(pool);
      const a = await newMember();
      const b = await newMember();
      const entry = await newEntryId();
      await log.write({
        expected: null,
        next: v(entry, 1, 'draft', [b]),
        content: {},
        action: 'incident.edit',
        context: { actorId: b, at: AT },
      });
      await log.write({
        expected: { version: 1, status: 'draft', editSeq: 0 },
        next: v(entry, 1, 'draft', [b, a]),
        content: { t: 1 },
        action: 'incident.edit',
        context: { actorId: a, at: AT },
      });
      expect((await log.findLatest(entry))?.version.contributorIds).toEqual([b, a]);
    });

    it('freezes a published row and allows one open version per entry, whatever the caller', async () => {
      const log = createPgIncidentLogStore(pool);
      const a = await newMember();
      const entry = await newEntryId();
      await log.write({
        expected: null,
        next: v(entry, 1, 'draft', [a]),
        content: {},
        action: 'incident.edit',
        context: { actorId: a, at: AT },
      });
      await log.write({
        expected: { version: 1, status: 'draft', editSeq: 0 },
        next: v(entry, 1, 'in_review', [a]),
        action: 'incident.submit',
        context: { actorId: a, at: AT },
      });
      await log.write({
        expected: { version: 1, status: 'in_review', editSeq: 1 },
        next: v(entry, 1, 'published', [a]),
        action: 'incident.publish',
        context: { actorId: a, at: AT },
      });

      await expect(
        pool.query(
          'UPDATE incident_log_versions SET content = \'{"t":"rewritten"}\' WHERE entry_id = $1',
          [entry],
        ),
      ).rejects.toThrow(/published and cannot change/);

      const insertDraft = (version: number) =>
        pool.query(
          `INSERT INTO incident_log_versions
             (entry_id, version, status, triggers_notifications, major, content, created_at, updated_at)
           VALUES ($1, $2, 'draft', false, false, '{}', now(), now())`,
          [entry, version],
        );
      await insertDraft(2);
      await expect(insertDraft(3)).rejects.toThrow(/incident_log_versions_one_open/);
    });

    it('runs the curated_correction rehearsal on Postgres (TASKS L15)', async () => {
      const log = createPgIncidentLogStore(pool);
      const curator = await newMember(['editor']);
      const reviewer = await newMember(['editor']);
      const report = await runCurationRehearsal(
        { log, newId: randomUUID },
        {
          curator: { staffId: curator, roles: ['editor'], secondFactorVerified: true },
          reviewer: { staffId: reviewer, roles: ['editor'], secondFactorVerified: true },
          startAt: AT,
        },
      );
      expect(report.steps.filter((step) => !step.passed)).toEqual([]);
      expect(report.passed).toBe(true);
      expect(await auditActions(report.entryId ?? '')).toEqual([
        'incident.draft',
        'incident.submit',
        'incident.publish',
        'incident.edit',
        'incident.submit',
        'incident.publish',
      ]);
    });
  });
});
