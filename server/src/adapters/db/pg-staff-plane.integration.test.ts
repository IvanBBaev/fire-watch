/**
 * The staff plane's storage (TASKS I1, migration 026) against a real Postgres: a TOTP step
 * is accepted once even when two requests race with it, a recovery code is spent once and
 * re-enrollment voids the old set, disabling a member locks their second factor, every
 * write lands on the audit trail in its transaction, and the incident log's versions are a
 * compare-and-set whose published rows 026 freezes and whose open version is unique.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import type { StaffStore } from '../../core/ports/staff-stores.js';
import type { IncidentEntryVersion } from '../../core/staff/incident-log-workflow.js';
import { hashEntityState } from '../../core/staff/staff-audit.js';
import { auditedState, createPgIncidentLogStore } from './pg-incident-log-store.js';
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
          expected: { version: 1, status: 'draft' },
          next: v(entry, 1, 'in_review', [editor]),
          action: 'incident.submit',
          context: { actorId: editor, at: AT },
        }),
      ).toEqual({ kind: 'written' });
      const published = v(entry, 1, 'published', [editor]);
      expect(
        await log.write({
          expected: { version: 1, status: 'in_review' },
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
          expected: { version: 1, status: 'published' },
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
          expected: { version: 1, status: 'draft' },
          next: v(entry, 1, 'in_review', [a]),
          action: 'incident.submit',
          context: { actorId: a, at: AT },
        }),
        log.write({
          expected: { version: 1, status: 'draft' },
          next: v(entry, 1, 'draft', [a, b]),
          content: { t: 'y' },
          action: 'incident.edit',
          context: { actorId: b, at: AT },
        }),
      ]);
      expect(results.map((r) => r.kind).sort()).toEqual(['conflict', 'written']);
      expect(await auditActions(entry)).toHaveLength(2);
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
        expected: { version: 1, status: 'draft' },
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
        expected: { version: 1, status: 'draft' },
        next: v(entry, 1, 'in_review', [a]),
        action: 'incident.submit',
        context: { actorId: a, at: AT },
      });
      await log.write({
        expected: { version: 1, status: 'in_review' },
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
  });
});
