import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../../core/ports/clock.js';
import { STAFF_AUDIT_ACTIONS } from '../../core/staff/staff-audit.js';
import { STAFF_ROLES } from '../../core/staff/staff-policy.js';
import {
  STAFF_CHALLENGE_PURPOSES,
  STAFF_SECOND_FACTOR_METHODS,
} from '../../core/staff/staff-session-policy.js';
import { WEBAUTHN_ALGORITHMS } from '../crypto/webauthn.js';
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

describe('createPgStaffStore — WebAuthn', () => {
  const CREDENTIAL = {
    credentialId: new Uint8Array(16).fill(0xc1),
    publicKeyCose: new Uint8Array(77).fill(0xa5),
    algorithm: -7,
    signCount: 0,
    backupEligible: true,
    label: 'Phone passkey',
  } as const;

  it('enrolls a credential and audits the method without the key', async () => {
    const stub = stubPool();
    const result = await createPgStaffStore(stub.pool).enrollWebAuthnCredential(
      STAFF,
      CREDENTIAL,
      null,
      { actorId: STAFF, ip: '192.0.2.9', at: AT },
    );
    expect(result).toEqual({ kind: 'enrolled' });
    // null keeps the existing recovery codes.
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockLiveMember',
      'insertWebAuthn',
      'insertAudit',
      'COMMIT',
    ]);
    expect(auditValues(stub).slice(0, 3)).toEqual([
      STAFF,
      'staff.second_factor_enrolled',
      'staff_member',
    ]);
    const insert = stub.queries.find((q) => q.text === STAFF_SQL.insertWebAuthn);
    expect(insert?.values[4]).toBe('0');
  });

  it('replaces the recovery codes when given a set', async () => {
    const stub = stubPool();
    await createPgStaffStore(stub.pool).enrollWebAuthnCredential(
      STAFF,
      CREDENTIAL,
      [new Uint8Array(32).fill(3)],
      { actorId: STAFF, at: AT },
    );
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockLiveMember',
      'insertWebAuthn',
      'deleteRecoveryCodes',
      'insertRecoveryCodes',
      'insertAudit',
      'COMMIT',
    ]);
  });

  it('reports a taken credential id without touching codes or the trail', async () => {
    const stub = stubPool({ insertWebAuthn: { rows: [], rowCount: 0 } });
    const result = await createPgStaffStore(stub.pool).enrollWebAuthnCredential(
      STAFF,
      CREDENTIAL,
      [new Uint8Array(32)],
      { actorId: STAFF, at: AT },
    );
    expect(result).toEqual({ kind: 'credential_taken' });
    expect(stub.trace()).toEqual(['BEGIN', 'lockLiveMember', 'insertWebAuthn', 'COMMIT']);
  });

  it('refuses a disabled member and an out-of-range counter', async () => {
    const disabled = stubPool({ lockLiveMember: { rows: [], rowCount: 0 } });
    await expect(
      createPgStaffStore(disabled.pool).enrollWebAuthnCredential(STAFF, CREDENTIAL, null, {
        actorId: STAFF,
        at: AT,
      }),
    ).rejects.toThrow(/disabled/);
    expect(disabled.trace().at(-1)).toBe('ROLLBACK');

    const stub = stubPool();
    const store = createPgStaffStore(stub.pool);
    await expect(
      store.enrollWebAuthnCredential(STAFF, { ...CREDENTIAL, signCount: 2 ** 32 }, null, {
        actorId: STAFF,
        at: AT,
      }),
    ).rejects.toThrow(RangeError);
    await expect(store.advanceWebAuthnSignCount(CREDENTIAL.credentialId, -1, AT)).rejects.toThrow(
      RangeError,
    );
  });

  it('decodes a stored credential', async () => {
    const row = {
      credential_id: Buffer.from([1, 2, 3]),
      staff_id: STAFF,
      public_key_cose: Buffer.from([4, 5]),
      algorithm: -8,
      sign_count: '42',
      backup_eligible: false,
      label: 'YubiKey',
      enrolled_at: new Date('2026-10-22T08:00:00Z'),
      last_used_at: null,
    };
    const stub = stubPool({
      findWebAuthn: { rows: [row], rowCount: 1 },
      listWebAuthn: { rows: [row, { ...row, algorithm: -35 }], rowCount: 2 },
    });
    const store = createPgStaffStore(stub.pool);
    expect(await store.findWebAuthnCredential(new Uint8Array([1, 2, 3]))).toEqual({
      credentialId: new Uint8Array([1, 2, 3]),
      staffId: STAFF,
      publicKeyCose: new Uint8Array([4, 5]),
      algorithm: -8,
      signCount: 42,
      backupEligible: false,
      label: 'YubiKey',
      enrolledAt: AT,
      lastUsedAt: null,
    });
    await expect(store.listWebAuthnCredentials(STAFF)).rejects.toThrow(/WebAuthn set/);
    expect(await store.findWebAuthnCredential(new Uint8Array())).toBeNull();
  });

  it('advances the counter only through the guarded update', async () => {
    const stub = stubPool({ advanceWebAuthnCount: { rows: [], rowCount: 0 } });
    expect(
      await createPgStaffStore(stub.pool).advanceWebAuthnSignCount(new Uint8Array([1]), 3, AT),
    ).toBe(false);
    expect(STAFF_SQL.advanceWebAuthnCount).toMatch(/sign_count < \$2::bigint/);
    expect(STAFF_SQL.advanceWebAuthnCount).toMatch(/sign_count = 0 AND \$2::bigint = 0/);
    expect(STAFF_SQL.advanceWebAuthnCount).toMatch(/disabled_at IS NULL/);
    expect(STAFF_SQL.listWebAuthn).toMatch(/disabled_at IS NULL/);
    expect(STAFF_SQL.findWebAuthn).toMatch(/disabled_at IS NULL/);
  });
});

describe('migration 027', () => {
  const sql = readFileSync(
    new URL('../../../db/migrations/027_staff_webauthn_credentials.sql', import.meta.url),
    'utf8',
  );

  it('allows exactly the algorithms the verifier accepts', () => {
    const match = /algorithm\s+integer NOT NULL CHECK \(algorithm IN \(([^)]*)\)\)/.exec(sql);
    const listed = (match?.[1] ?? '').split(',').map((v) => Number(v.trim()));
    expect(listed.sort()).toEqual(Object.values(WEBAUTHN_ALGORITHMS).sort());
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

  it('allowed the actions the audit record carried before migration 029', () => {
    const before029 = STAFF_AUDIT_ACTIONS.filter((a) => a !== 'staff.second_factor_removed');
    expect(checkList('action').sort()).toEqual([...before029].sort());
  });
});

describe('migration 029', () => {
  const sql = readFileSync(
    new URL('../../../db/migrations/029_staff_sessions.sql', import.meta.url),
    'utf8',
  );
  const up = sql.slice(0, sql.indexOf('-- migrate:down'));

  function quoted(list: string | undefined): string[] {
    if (list === undefined) throw new Error('no CHECK list');
    return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
  }

  it('allows exactly the actions the audit record can carry', () => {
    const match = /staff_audit_log_action_check CHECK \(action IN \(([^)]*)\)\)/.exec(up);
    expect(quoted(match?.[1]).sort()).toEqual([...STAFF_AUDIT_ACTIONS].sort());
  });

  it('allows exactly the second-factor methods and challenge purposes the policy knows', () => {
    const methods =
      /second_factor_method\s+text CHECK \(second_factor_method IN \(([^)]*)\)\)/.exec(up);
    const purposes = /challenge_purpose\s+text CHECK \(challenge_purpose IN \(([^)]*)\)\)/.exec(up);
    expect(quoted(methods?.[1]).sort()).toEqual([...STAFF_SECOND_FACTOR_METHODS].sort());
    expect(quoted(purposes?.[1]).sort()).toEqual([...STAFF_CHALLENGE_PURPOSES].sort());
  });
});

describe('createPgStaffStore — removal and member changes', () => {
  const CREDENTIAL = new Uint8Array([1, 2, 3, 4]);
  const ctx = { actorId: ADMIN, ip: '192.0.2.1', at: AT };

  it('removes a credential, ends its sessions and audits the removal in one transaction', async () => {
    const stub = stubPool({
      lockOwnWebAuthn: { rows: [{ algorithm: -7, backup_eligible: true }], rowCount: 1 },
      countSecondFactors: { rows: [{ factors: 2 }], rowCount: 1 },
      revokeSessionsByCredential: { rows: [], rowCount: 3 },
    });
    const result = await createPgStaffStore(stub.pool).removeWebAuthnCredential(
      STAFF,
      CREDENTIAL,
      ctx,
    );
    expect(result).toEqual({ kind: 'removed', sessionsRevoked: 3 });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockLiveMember',
      'lockOwnWebAuthn',
      'countSecondFactors',
      'deleteWebAuthn',
      'revokeSessionsByCredential',
      'insertAudit',
      'COMMIT',
    ]);
    const values = auditValues(stub);
    expect(values.slice(0, 4)).toEqual([
      ADMIN,
      'staff.second_factor_removed',
      'staff_member',
      STAFF,
    ]);
    expect(values[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(values[5]).toBeNull();
  });

  it('refuses to remove the last factor and touches nothing', async () => {
    const stub = stubPool({
      lockOwnWebAuthn: { rows: [{ algorithm: -7, backup_eligible: false }], rowCount: 1 },
      countSecondFactors: { rows: [{ factors: 1 }], rowCount: 1 },
    });
    const result = await createPgStaffStore(stub.pool).removeWebAuthnCredential(
      STAFF,
      CREDENTIAL,
      ctx,
    );
    expect(result).toEqual({ kind: 'last_second_factor' });
    expect(stub.trace()).not.toContain('deleteWebAuthn');
    expect(stub.trace()).not.toContain('insertAudit');
  });

  it("reports another member's or an unknown credential as not found", async () => {
    const stub = stubPool({ lockOwnWebAuthn: { rows: [], rowCount: 0 } });
    const store = createPgStaffStore(stub.pool);
    expect(await store.removeWebAuthnCredential(STAFF, CREDENTIAL, ctx)).toEqual({
      kind: 'not_found',
    });
    const disabled = stubPool({ lockLiveMember: { rows: [], rowCount: 0 } });
    expect(
      await createPgStaffStore(disabled.pool).removeWebAuthnCredential(STAFF, CREDENTIAL, ctx),
    ).toEqual({ kind: 'not_found' });
    expect(disabled.trace()).not.toContain('lockOwnWebAuthn');
  });

  it('disables a member, ends every session and audits it', async () => {
    const stub = stubPool({ revokeMemberSessions: { rows: [], rowCount: 2 } });
    const result = await createPgStaffStore(stub.pool).disableMember(STAFF, ctx);
    expect(result).toEqual({ kind: 'disabled', sessionsRevoked: 2 });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'disableMember',
      'revokeMemberSessions',
      'insertAudit',
      'COMMIT',
    ]);
    expect(auditValues(stub).slice(0, 2)).toEqual([ADMIN, 'staff.manage']);
  });

  it('does not disable twice', async () => {
    const stub = stubPool({ disableMember: { rows: [], rowCount: 0 } });
    expect(await createPgStaffStore(stub.pool).disableMember(STAFF, ctx)).toEqual({
      kind: 'not_found',
    });
    expect(stub.trace()).not.toContain('insertAudit');
  });

  it('diffs the role set and audits only a change', async () => {
    const stub = stubPool({
      lockedRoles: { rows: [{ role: 'editor' }, { role: 'moderator' }], rowCount: 2 },
    });
    const store = createPgStaffStore(stub.pool);
    expect(await store.setRoles(STAFF, ['admin', 'editor'], ctx)).toEqual({ kind: 'changed' });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockLiveMember',
      'lockedRoles',
      'deleteRole',
      'insertRole',
      'insertAudit',
      'COMMIT',
    ]);
    const same = stubPool({ lockedRoles: { rows: [{ role: 'editor' }], rowCount: 1 } });
    expect(await createPgStaffStore(same.pool).setRoles(STAFF, ['editor', 'editor'], ctx)).toEqual({
      kind: 'unchanged',
    });
    expect(same.trace()).not.toContain('insertAudit');
  });

  it('counts factors as zero for a disabled or unknown member', async () => {
    const stub = stubPool({ countSecondFactors: { rows: [], rowCount: 0 } });
    expect(await createPgStaffStore(stub.pool).countSecondFactors(STAFF)).toBe(0);
  });
});

describe('createPgStaffStore — TOTP removal and off-boarding', () => {
  const ctx = { actorId: ADMIN, ip: '192.0.2.1', at: AT };

  it('removes the TOTP factor, ends the sessions it signed and audits it without the secret', async () => {
    const stub = stubPool({
      lockOwnTotp: { rows: [{ algorithm: 'sha1' }], rowCount: 1 },
      countSecondFactors: { rows: [{ factors: 2 }], rowCount: 1 },
      revokeSessionsByMethod: { rows: [], rowCount: 2 },
    });
    const result = await createPgStaffStore(stub.pool).removeTotpFactor(STAFF, ctx);
    expect(result).toEqual({ kind: 'removed', sessionsRevoked: 2 });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockLiveMember',
      'lockOwnTotp',
      'countSecondFactors',
      'deleteTotp',
      'revokeSessionsByMethod',
      'insertAudit',
      'COMMIT',
    ]);
    const revoke = stub.queries.find((q) => q.text === STAFF_SQL.revokeSessionsByMethod);
    expect(revoke?.values.slice(0, 2)).toEqual([STAFF, 'totp']);
    expect(stub.trace()).not.toContain('deleteRecoveryCodes');
    expect(auditValues(stub).slice(0, 4)).toEqual([
      ADMIN,
      'staff.second_factor_removed',
      'staff_member',
      STAFF,
    ]);
  });

  it('refuses to remove the last second factor and reports a missing one as not found', async () => {
    const last = stubPool({
      lockOwnTotp: { rows: [{ algorithm: 'sha1' }], rowCount: 1 },
      countSecondFactors: { rows: [{ factors: 1 }], rowCount: 1 },
    });
    expect(await createPgStaffStore(last.pool).removeTotpFactor(STAFF, ctx)).toEqual({
      kind: 'last_second_factor',
    });
    expect(last.trace()).not.toContain('deleteTotp');
    expect(last.trace()).not.toContain('insertAudit');
    const none = stubPool({ lockOwnTotp: { rows: [], rowCount: 0 } });
    expect(await createPgStaffStore(none.pool).removeTotpFactor(STAFF, ctx)).toEqual({
      kind: 'not_found',
    });
  });

  it('off-boards a live member: disable, sessions, every factor, codes and roles, one audit row', async () => {
    const stub = stubPool({
      lockAnyMember: { rows: [{ live: true }], rowCount: 1 },
      revokeMemberSessions: { rows: [], rowCount: 2 },
      deleteMemberWebAuthn: { rows: [], rowCount: 1 },
      deleteTotp: { rows: [], rowCount: 1 },
      deleteRecoveryCodes: { rows: [], rowCount: 10 },
      deleteMemberRoles: { rows: [{ role: 'moderator' }, { role: 'editor' }], rowCount: 2 },
    });
    const result = await createPgStaffStore(stub.pool).offboardMember(STAFF, ctx);
    expect(result).toEqual({
      kind: 'offboarded',
      wasLive: true,
      sessionsRevoked: 2,
      webauthnRemoved: 1,
      totpRemoved: 1,
      recoveryCodesRemoved: 10,
      rolesRemoved: ['editor', 'moderator'],
    });
    expect(stub.trace()).toEqual([
      'BEGIN',
      'lockAnyMember',
      'disableMember',
      'revokeMemberSessions',
      'deleteMemberWebAuthn',
      'deleteTotp',
      'deleteRecoveryCodes',
      'deleteMemberRoles',
      'insertAudit',
      'COMMIT',
    ]);
    expect(auditValues(stub).slice(0, 2)).toEqual([ADMIN, 'staff.manage']);
  });

  it('finishes a disabled member and reports a clean one as already off-boarded', async () => {
    const leftover = stubPool({
      lockAnyMember: { rows: [{ live: false }], rowCount: 1 },
      revokeMemberSessions: { rows: [], rowCount: 0 },
      deleteMemberWebAuthn: { rows: [], rowCount: 1 },
      deleteTotp: { rows: [], rowCount: 0 },
      deleteRecoveryCodes: { rows: [], rowCount: 0 },
      deleteMemberRoles: { rows: [], rowCount: 0 },
    });
    const finished = await createPgStaffStore(leftover.pool).offboardMember(STAFF, ctx);
    expect(finished).toMatchObject({ kind: 'offboarded', wasLive: false, webauthnRemoved: 1 });
    expect(leftover.trace()).not.toContain('disableMember');
    expect(leftover.trace()).toContain('insertAudit');

    const clean = stubPool({
      lockAnyMember: { rows: [{ live: false }], rowCount: 1 },
      revokeMemberSessions: { rows: [], rowCount: 0 },
      deleteMemberWebAuthn: { rows: [], rowCount: 0 },
      deleteTotp: { rows: [], rowCount: 0 },
      deleteRecoveryCodes: { rows: [], rowCount: 0 },
      deleteMemberRoles: { rows: [], rowCount: 0 },
    });
    expect(await createPgStaffStore(clean.pool).offboardMember(STAFF, ctx)).toEqual({
      kind: 'already_offboarded',
    });
    expect(clean.trace()).not.toContain('insertAudit');

    const unknown = stubPool({ lockAnyMember: { rows: [], rowCount: 0 } });
    expect(await createPgStaffStore(unknown.pool).offboardMember(STAFF, ctx)).toEqual({
      kind: 'not_found',
    });
  });
});

describe('migration 030', () => {
  const sql = readFileSync(
    new URL('../../../db/migrations/030_staff_totp_removal_and_offboarding.sql', import.meta.url),
    'utf8',
  );

  it('grants the TOTP delete and the failure counter, and undoes both', () => {
    const [up = '', down = ''] = sql.split('-- migrate:down');
    expect(up).toMatch(/GRANT DELETE ON staff_totp_factors TO fire_watch_app/);
    expect(up).toMatch(/second_factor_failures integer NOT NULL DEFAULT 0/);
    expect(down).toMatch(/REVOKE DELETE ON staff_totp_factors FROM fire_watch_app/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS second_factor_failures/);
  });
});
