/**
 * The staff plane's people and audit trail over Postgres (TASKS I1; 05 C3, §5.4.3;
 * migration 026).
 *
 * **Transactions.** Creating a member (row, role grants, audit row), enrolling a factor
 * (factor, recovery-code set, audit row) and using a recovery code (mark used, audit row)
 * are each one transaction, so the trail never records an action that rolled back and
 * never misses one that committed.
 *
 * **Replay.** {@link StaffStore.advanceTotpStep} is a single conditional UPDATE: the
 * `last_used_step < step` predicate is evaluated under the row lock the UPDATE takes, so of
 * two requests racing with the same code exactly one moves the step and the other updates
 * nothing. Recovery codes use the same shape (`used_at IS NULL`).
 *
 * A disabled member keeps their rows (the trail references them) but every second-factor
 * read and write refuses them, so disabling is enough to lock someone out.
 */

import { createHash, randomUUID } from 'node:crypto';

import { isoFromEpochMs } from '../../core/ports/clock.js';
import type {
  StaffMember,
  StaffStore,
  StoredTotpAlgorithm,
  StoredTotpFactor,
} from '../../core/ports/staff-stores.js';
import { buildStaffAuditRecord, type StaffAuditRecord } from '../../core/staff/staff-audit.js';
import { isStaffRole, type StaffRole } from '../../core/staff/staff-policy.js';
import { field, seqFrom, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgStaffQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgStaffClient extends PgStaffQueryable {
  release(): void;
}

export interface PgStaffPool extends PgStaffQueryable {
  connect(): Promise<PgStaffClient>;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const INSERT_MEMBER = `
INSERT INTO staff_members (id, email, display_name, created_at)
VALUES (COALESCE($1::uuid, gen_random_uuid()), $2::text, $3::text, $4::timestamptz)
ON CONFLICT (email) DO NOTHING
RETURNING id::text AS id`;

const INSERT_ROLE = `
INSERT INTO staff_role_grants (staff_id, role, granted_at)
VALUES ($1::uuid, $2::text, $3::timestamptz)`;

const FIND_MEMBER = `
SELECT m.id::text AS id, m.email, m.display_name, (m.disabled_at IS NOT NULL) AS disabled,
       COALESCE(array_agg(g.role ORDER BY g.role) FILTER (WHERE g.role IS NOT NULL), '{}') AS roles
FROM staff_members m
LEFT JOIN staff_role_grants g ON g.staff_id = m.id
WHERE m.id = $1::uuid
GROUP BY m.id`;

const LOCK_LIVE_MEMBER = `
SELECT 1 FROM staff_members WHERE id = $1::uuid AND disabled_at IS NULL FOR UPDATE`;

const UPSERT_TOTP = `
INSERT INTO staff_totp_factors (staff_id, secret_ciphertext, secret_key_id, algorithm, enrolled_at)
VALUES ($1::uuid, $2::bytea, $3::text, $4::text, $5::timestamptz)
ON CONFLICT (staff_id) DO UPDATE
SET secret_ciphertext = EXCLUDED.secret_ciphertext,
    secret_key_id = EXCLUDED.secret_key_id,
    algorithm = EXCLUDED.algorithm,
    enrolled_at = EXCLUDED.enrolled_at,
    last_used_step = NULL`;

const DELETE_RECOVERY_CODES = `DELETE FROM staff_recovery_codes WHERE staff_id = $1::uuid`;

const INSERT_RECOVERY_CODES = `
INSERT INTO staff_recovery_codes (staff_id, code_hash, issued_at)
SELECT $1::uuid, hash, $3::timestamptz FROM unnest($2::bytea[]) AS hash`;

const FIND_TOTP = `
SELECT f.secret_ciphertext, f.secret_key_id, f.algorithm, f.last_used_step::text AS last_used_step
FROM staff_totp_factors f
JOIN staff_members m ON m.id = f.staff_id
WHERE f.staff_id = $1::uuid AND m.disabled_at IS NULL`;

/** The predicate is the replay guard; it repeats `verifyTotp`'s check on purpose. */
const ADVANCE_TOTP_STEP = `
UPDATE staff_totp_factors f
SET last_used_step = $2::bigint
FROM staff_members m
WHERE f.staff_id = $1::uuid AND m.id = f.staff_id AND m.disabled_at IS NULL
  AND (f.last_used_step IS NULL OR f.last_used_step < $2::bigint)`;

const CONSUME_RECOVERY_CODE = `
UPDATE staff_recovery_codes c
SET used_at = $3::timestamptz
FROM staff_members m
WHERE c.staff_id = $1::uuid AND c.code_hash = $2::bytea AND c.used_at IS NULL
  AND m.id = c.staff_id AND m.disabled_at IS NULL`;

export const INSERT_AUDIT = `
INSERT INTO staff_audit_log
  (actor_id, action, entity_kind, entity_id, before_hash, after_hash, ip, at)
VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::inet, $8::timestamptz)`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const STAFF_SQL = {
  insertMember: INSERT_MEMBER,
  insertRole: INSERT_ROLE,
  findMember: FIND_MEMBER,
  lockLiveMember: LOCK_LIVE_MEMBER,
  upsertTotp: UPSERT_TOTP,
  deleteRecoveryCodes: DELETE_RECOVERY_CODES,
  insertRecoveryCodes: INSERT_RECOVERY_CODES,
  findTotp: FIND_TOTP,
  advanceTotpStep: ADVANCE_TOTP_STEP,
  consumeRecoveryCode: CONSUME_RECOVERY_CODE,
  insertAudit: INSERT_AUDIT,
} as const;

export async function insertAuditRecord(
  db: PgStaffQueryable,
  record: StaffAuditRecord,
): Promise<void> {
  const result = await db.query(INSERT_AUDIT, [
    record.actorId,
    record.action,
    record.entityKind,
    record.entityId,
    record.beforeHash,
    record.afterHash,
    record.ip,
    record.atIso,
  ]);
  if (result.rowCount !== 1) throw new Error('staff audit insert did not write exactly one row');
}

export function createPgStaffStore(
  pool: PgStaffPool,
  options: { readonly newId?: () => string } = {},
): StaffStore {
  const newId = options.newId ?? randomUUID;
  return {
    createMember: (member, context) =>
      inTransaction(pool, async (client) => {
        const roles = [...new Set(member.roles)].sort();
        const atIso = isoFromEpochMs(context.at);
        const id = newId();
        const inserted = await client.query(INSERT_MEMBER, [
          id,
          member.email,
          member.displayName,
          atIso,
        ]);
        const [row] = inserted.rows;
        if (row === undefined) return { kind: 'email_taken' } as const;
        const staffId = string(field(row, 'id'), 'id');
        for (const role of roles) await client.query(INSERT_ROLE, [staffId, role, atIso]);
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: context.actorId ?? staffId,
              action: 'staff.manage',
              entity: { kind: 'staff_member', id: staffId },
              after: { email: member.email, displayName: member.displayName, roles },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return { kind: 'created', staffId } as const;
      }),

    async findMember(staffId) {
      const result = await pool.query(FIND_MEMBER, [staffId]);
      const [row] = result.rows;
      return row === undefined ? null : decodeMember(row);
    },

    enrollTotp: (staffId, factor, recoveryCodeHashes, context) =>
      inTransaction(pool, async (client) => {
        for (const hash of recoveryCodeHashes) {
          if (hash.length !== 32) throw new TypeError('a recovery code hash is 32 bytes');
        }
        const live = await client.query(LOCK_LIVE_MEMBER, [staffId]);
        if (live.rowCount !== 1)
          throw new Error('cannot enroll a factor for an unknown or disabled member');
        const atIso = isoFromEpochMs(context.at);
        await client.query(UPSERT_TOTP, [
          staffId,
          Buffer.from(factor.sealed.ciphertext),
          factor.sealed.keyId,
          factor.algorithm,
          atIso,
        ]);
        await client.query(DELETE_RECOVERY_CODES, [staffId]);
        await client.query(INSERT_RECOVERY_CODES, [
          staffId,
          recoveryCodeHashes.map((hash) => Buffer.from(hash)),
          atIso,
        ]);
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: context.actorId,
              action: 'staff.second_factor_enrolled',
              entity: { kind: 'staff_member', id: staffId },
              // The method and the count, never the secret or a code.
              after: {
                method: 'totp',
                algorithm: factor.algorithm,
                recoveryCodes: recoveryCodeHashes.length,
              },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
      }),

    async findTotpFactor(staffId) {
      const result = await pool.query(FIND_TOTP, [staffId]);
      const [row] = result.rows;
      return row === undefined ? null : decodeTotp(row);
    },

    async advanceTotpStep(staffId, step) {
      if (!Number.isSafeInteger(step) || step < 0)
        throw new RangeError('a TOTP step is a non-negative integer');
      const result = await pool.query(ADVANCE_TOTP_STEP, [staffId, String(step)]);
      return result.rowCount === 1;
    },

    consumeRecoveryCode: (staffId, codeHash, context) =>
      inTransaction(pool, async (client) => {
        if (codeHash.length !== 32) return false;
        const used = await client.query(CONSUME_RECOVERY_CODE, [
          staffId,
          Buffer.from(codeHash),
          isoFromEpochMs(context.at),
        ]);
        if (used.rowCount !== 1) return false;
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: staffId,
              action: 'staff.recovery_code_used',
              entity: { kind: 'staff_member', id: staffId },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return true;
      }),

    appendAudit: (record) => insertAuditRecord(pool, record),
  };
}

/** Same shape as `pg-auth.ts`: ROLLBACK's own failure never masks the original. */
export async function inTransaction<T>(
  pool: PgStaffPool,
  work: (client: PgStaffClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function decodeMember(row: Record<string, unknown>): StaffMember {
  const rawRoles = field(row, 'roles');
  if (!Array.isArray(rawRoles)) throw new Error('roles is not an array');
  const roles: StaffRole[] = [];
  for (const role of rawRoles) {
    // 026's CHECK holds the set; an unknown role is a newer migration than this build,
    // and granting nothing for it is the safe reading.
    if (isStaffRole(role)) roles.push(role);
  }
  const disabled = field(row, 'disabled');
  if (typeof disabled !== 'boolean') throw new Error('disabled is not a boolean');
  return {
    staffId: string(field(row, 'id'), 'id'),
    email: string(field(row, 'email'), 'email'),
    displayName: string(field(row, 'display_name'), 'display_name'),
    roles,
    disabled,
  };
}

const ALGORITHMS: readonly StoredTotpAlgorithm[] = ['sha1', 'sha256', 'sha512'];

function decodeTotp(row: Record<string, unknown>): StoredTotpFactor {
  const ciphertext = field(row, 'secret_ciphertext');
  if (!(ciphertext instanceof Uint8Array)) throw new Error('secret_ciphertext is not bytes');
  const algorithm = string(field(row, 'algorithm'), 'algorithm');
  if (!(ALGORITHMS as readonly string[]).includes(algorithm)) {
    throw new Error('algorithm holds a value outside the TOTP set');
  }
  const step = field(row, 'last_used_step');
  return {
    sealed: {
      ciphertext: new Uint8Array(ciphertext),
      keyId: string(field(row, 'secret_key_id'), 'secret_key_id'),
    },
    algorithm: algorithm as StoredTotpAlgorithm,
    lastUsedStep: step === null ? null : seqFrom(step, 'last_used_step'),
  };
}
