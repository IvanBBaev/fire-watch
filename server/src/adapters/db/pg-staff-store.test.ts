import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import { STAFF_AUDIT_ACTIONS } from '../../core/staff/staff-audit.js';
import { STAFF_ROLES } from '../../core/staff/staff-policy.js';
import { createPgStaffStore, STAFF_SQL, type PgStaffClient } from './pg-staff-store.js';

const AT = epochMsFromIso('2026-10-22T08:00:00Z');
const STAFF = '26262626-0000-4000-8000-000000000001';
const ADMIN = '26262626-0000-4000-8000-000000000002';

type Answer = { rows: Record<string, unknown>[]; rowCount: number } | Error;

/** A stub pool answering by statement; anything unlisted gets no rows and rowCount 1. */
function stubPool(answers: Partial<Record<keyof typeof STAFF_SQL, Answer>> = {}) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  let released = 0;
  const byText = new Map<string, Answer>();
  for (const [key, answer] of Object.entries(answers)) {
    byText.set(STAFF_SQL[key as keyof typeof STAFF_SQL], answer);
  }
  const query = <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ) => {
    queries.push({ text, values });
    const answer = byText.get(text);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      rows: (answer?.rows ?? []) as Row[],
      rowCount: answer?.rowCount ?? 1,
    });
  };
  const client: PgStaffClient = {
    query,
    release() {
      released += 1;
    },
  };
  const keyOf = new Map<string, string>(
    Object.entries(STAFF_SQL).map(([key, text]) => [text, key]),
  );
  return {
    queries,
    trace: () => queries.map((q) => keyOf.get(q.text) ?? q.text),
    released: () => released,
    pool: { query, connect: () => Promise.resolve(client) },
  };
}

function auditValues(stub: ReturnType<typeof stubPool>): readonly unknown[] {
  const audit = stub.queries.find((q) => q.text === STAFF_SQL.insertAudit);
  if (audit === undefined) throw new Error('no audit row written');
  return audit.values;
}

describe('createPgStaffStore', () => {
  it('creates a member, grants roles in a stable order and audits it in one transaction', async () => {
    const stub = stubPool({ insertMember: { rows: [{ id: STAFF }], rowCount: 1 } });
    const store = createPgStaffStore(stub.pool, { newId: () => STAFF });
    const result = await store.createMember(
      { email: 'ed@example.org', displayName: 'Ed', roles: ['editor', 'admin', 'editor'] },
      { actorId: ADMIN, ip: '192.0.2.1', at: AT },
    );
    expect(result).toEqual({ kind: 'created', staffId: STAFF });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'insertMember',
      'insertRole',
      'insertRole',
      'insertAudit',
      'COMMIT',
    ]);
    const roles = stub.queries
      .filter((q) => q.text === STAFF_SQL.insertRole)
      .map((q) => q.values[1]);
    expect(roles).toEqual(['admin', 'editor']);
    const audit = auditValues(stub);
    expect(audit.slice(0, 4)).toEqual([ADMIN, 'staff.manage', 'staff_member', STAFF]);
    expect(audit[4]).toBeNull();
    expect(audit[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(audit[6]).toBe('192.0.2.1');
    expect(stub.released()).toBe(1);
  });

  it('records the bootstrap member as their own actor', async () => {
    const stub = stubPool({ insertMember: { rows: [{ id: STAFF }], rowCount: 1 } });
    const store = createPgStaffStore(stub.pool, { newId: () => STAFF });
    await store.createMember(
      { email: 'a@example.org', displayName: 'A', roles: ['admin'] },
      { actorId: null, at: AT },
    );
    expect(auditValues(stub)[0]).toBe(STAFF);
    expect(auditValues(stub)[6]).toBeNull();
  });

  it('reports a taken email without granting or auditing anything', async () => {
    const stub = stubPool({ insertMember: { rows: [], rowCount: 0 } });
    const store = createPgStaffStore(stub.pool);
    const result = await store.createMember(
      { email: 'ed@example.org', displayName: 'Ed', roles: ['editor'] },
      { actorId: ADMIN, at: AT },
    );
    expect(result).toEqual({ kind: 'email_taken' });
    expect(stub.trace()).toEqual(['BEGIN', 'insertMember', 'COMMIT']);
  });

  it('rolls back and rethrows when the audit insert fails', async () => {
    const stub = stubPool({
      insertMember: { rows: [{ id: STAFF }], rowCount: 1 },
      insertAudit: new Error('audit down'),
    });
    const store = createPgStaffStore(stub.pool);
    await expect(
      store.createMember(
        { email: 'e@example.org', displayName: 'E', roles: [] },
        { actorId: ADMIN, at: AT },
      ),
    ).rejects.toThrow('audit down');
    expect(stub.trace().at(-1)).toBe('ROLLBACK');
    expect(stub.released()).toBe(1);
  });

  it('decodes a member and drops a role this build does not know', async () => {
    const stub = stubPool({
      findMember: {
        rows: [
          {
            id: STAFF,
            email: 'e@example.org',
            display_name: 'E',
            disabled: false,
            roles: ['editor', 'future-role'],
          },
        ],
        rowCount: 1,
      },
    });
    const member = await createPgStaffStore(stub.pool).findMember(STAFF);
    expect(member).toEqual({
      staffId: STAFF,
      email: 'e@example.org',
      displayName: 'E',
      roles: ['editor'],
      disabled: false,
    });
  });

  it('enrolls a factor, replaces the recovery codes and audits without the secret', async () => {
    const stub = stubPool();
    const store = createPgStaffStore(stub.pool);
    const codes = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    await store.enrollTotp(
      STAFF,
      { sealed: { ciphertext: new Uint8Array(40).fill(9), keyId: 'k1' }, algorithm: 'sha1' },
      codes,
      { actorId: STAFF, at: AT },
    );
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockLiveMember',
      'upsertTotp',
      'deleteRecoveryCodes',
      'insertRecoveryCodes',
      'insertAudit',
      'COMMIT',
    ]);
    expect(auditValues(stub)[1]).toBe('staff.second_factor_enrolled');
    expect(STAFF_SQL.upsertTotp).toContain('last_used_step = NULL');
  });

  it('refuses to enroll a disabled or unknown member', async () => {
    const stub = stubPool({ lockLiveMember: { rows: [], rowCount: 0 } });
    await expect(
      createPgStaffStore(stub.pool).enrollTotp(
        STAFF,
        { sealed: { ciphertext: new Uint8Array(40), keyId: 'k1' }, algorithm: 'sha1' },
        [],
        { actorId: STAFF, at: AT },
      ),
    ).rejects.toThrow(/disabled/);
    expect(stub.trace().at(-1)).toBe('ROLLBACK');
  });

  it('rejects a recovery code hash of the wrong length before touching the database', async () => {
    const stub = stubPool();
    await expect(
      createPgStaffStore(stub.pool).enrollTotp(
        STAFF,
        { sealed: { ciphertext: new Uint8Array(40), keyId: 'k1' }, algorithm: 'sha1' },
        [new Uint8Array(16)],
        { actorId: STAFF, at: AT },
      ),
    ).rejects.toThrow(/32 bytes/);
    expect(stub.trace()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('decodes a stored factor and its bigint step', async () => {
    const stub = stubPool({
      findTotp: {
        rows: [
          {
            secret_ciphertext: Buffer.from([1, 2, 3]),
            secret_key_id: 'k1',
            algorithm: 'sha256',
            last_used_step: '58000000',
          },
        ],
        rowCount: 1,
      },
    });
    const factor = await createPgStaffStore(stub.pool).findTotpFactor(STAFF);
    expect(factor).toEqual({
      sealed: { ciphertext: new Uint8Array([1, 2, 3]), keyId: 'k1' },
      algorithm: 'sha256',
      lastUsedStep: 58_000_000,
    });
  });

  it('advances the step only through the guarded update', async () => {
    const stub = stubPool({ advanceTotpStep: { rows: [], rowCount: 0 } });
    const store = createPgStaffStore(stub.pool);
    expect(await store.advanceTotpStep(STAFF, 7)).toBe(false);
    expect(STAFF_SQL.advanceTotpStep).toMatch(/last_used_step < \$2/);
    expect(STAFF_SQL.advanceTotpStep).toMatch(/disabled_at IS NULL/);
    await expect(store.advanceTotpStep(STAFF, -1)).rejects.toThrow(RangeError);
  });

  it('audits a recovery code only when it was actually consumed', async () => {
    const used = stubPool({ consumeRecoveryCode: { rows: [], rowCount: 0 } });
    expect(
      await createPgStaffStore(used.pool).consumeRecoveryCode(STAFF, new Uint8Array(32), {
        at: AT,
      }),
    ).toBe(false);
    expect(used.trace()).toEqual(['BEGIN', 'consumeRecoveryCode', 'COMMIT']);

    const fresh = stubPool();
    expect(
      await createPgStaffStore(fresh.pool).consumeRecoveryCode(STAFF, new Uint8Array(32), {
        at: AT,
      }),
    ).toBe(true);
    expect(fresh.trace()).toEqual(['BEGIN', 'consumeRecoveryCode', 'insertAudit', 'COMMIT']);
    expect(auditValues(fresh).slice(0, 2)).toEqual([STAFF, 'staff.recovery_code_used']);
  });
});

describe('migration 026', () => {
  const sql = readFileSync(
    new URL('../../../db/migrations/026_staff_plane_and_incident_log.sql', import.meta.url),
    'utf8',
  );

  function checkList(column: string): string[] {
    const match = new RegExp(
      `${column}\\s+text NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`,
    ).exec(sql);
    if (match?.[1] === undefined) throw new Error(`no CHECK list for ${column}`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
  }

  it('allows exactly the roles the policy knows', () => {
    expect(checkList('role').sort()).toEqual([...STAFF_ROLES].sort());
  });

  it('allows exactly the actions the audit record can carry', () => {
    expect(checkList('action').sort()).toEqual([...STAFF_AUDIT_ACTIONS].sort());
  });
});
