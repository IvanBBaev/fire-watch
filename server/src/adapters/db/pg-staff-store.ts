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
 * WebAuthn's signature counter (migration 027) is the same shape:
 * {@link StaffStore.advanceWebAuthnSignCount} repeats `signCountAdvances` as the UPDATE's
 * predicate, so of two assertions racing with one counter value exactly one lands.
 *
 * Removing a credential (migration 029) counts the member's factors under the member's row
 * lock and refuses to take the last one; it ends the sessions that credential let in.
 * Disabling a member ends all of their sessions in the same transaction.
 *
 * Removing the TOTP factor (migration 030) follows the credential's rule under the same
 * lock and ends the sessions TOTP let in. Off-boarding locks the member row whatever its
 * state, disables it if live, ends every session and deletes every credential, the TOTP
 * factor, the recovery codes and the role grants — one transaction, one `staff.manage`
 * row carrying the counts (docs/runbooks/06-staff-offboarding.md).
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
  StoredWebAuthnAlgorithm,
  StoredWebAuthnCredential,
} from '../../core/ports/staff-stores.js';
import { buildStaffAuditRecord, type StaffAuditRecord } from '../../core/staff/staff-audit.js';
import { isStaffRole, type StaffRole } from '../../core/staff/staff-policy.js';
import { boolean, epochMs, field, number, seqFrom, string } from './pg-rows.js';

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

const INSERT_WEBAUTHN = `
INSERT INTO staff_webauthn_credentials
  (credential_id, staff_id, public_key_cose, algorithm, sign_count, backup_eligible, label,
   enrolled_at)
VALUES ($1::bytea, $2::uuid, $3::bytea, $4::integer, $5::bigint, $6::boolean, $7::text,
        $8::timestamptz)
ON CONFLICT (credential_id) DO NOTHING`;

const WEBAUTHN_COLUMNS = `
c.credential_id, c.staff_id::text AS staff_id, c.public_key_cose, c.algorithm,
c.sign_count::text AS sign_count, c.backup_eligible, c.label, c.enrolled_at, c.last_used_at`;

const LIST_WEBAUTHN = `
SELECT ${WEBAUTHN_COLUMNS}
FROM staff_webauthn_credentials c
JOIN staff_members m ON m.id = c.staff_id
WHERE c.staff_id = $1::uuid AND m.disabled_at IS NULL
ORDER BY c.enrolled_at, c.credential_id`;

const FIND_WEBAUTHN = `
SELECT ${WEBAUTHN_COLUMNS}
FROM staff_webauthn_credentials c
JOIN staff_members m ON m.id = c.staff_id
WHERE c.credential_id = $1::bytea AND m.disabled_at IS NULL`;

/** The predicate is `signCountAdvances` (webauthn.ts), repeated as the clone guard. */
const ADVANCE_WEBAUTHN_COUNT = `
UPDATE staff_webauthn_credentials c
SET sign_count = $2::bigint, last_used_at = $3::timestamptz
FROM staff_members m
WHERE c.credential_id = $1::bytea AND m.id = c.staff_id AND m.disabled_at IS NULL
  AND (c.sign_count < $2::bigint OR (c.sign_count = 0 AND $2::bigint = 0))`;

const COUNT_SECOND_FACTORS = `
SELECT ((SELECT count(*) FROM staff_webauthn_credentials c WHERE c.staff_id = m.id)
      + (SELECT count(*) FROM staff_totp_factors f WHERE f.staff_id = m.id))::integer AS factors
FROM staff_members m
WHERE m.id = $1::uuid AND m.disabled_at IS NULL`;

const LOCK_OWN_WEBAUTHN = `
SELECT algorithm, backup_eligible
FROM staff_webauthn_credentials
WHERE credential_id = $1::bytea AND staff_id = $2::uuid
FOR UPDATE`;

const DELETE_WEBAUTHN = `
DELETE FROM staff_webauthn_credentials WHERE credential_id = $1::bytea AND staff_id = $2::uuid`;

/** Ends the sessions a removed credential let in (migration 029). */
const REVOKE_SESSIONS_BY_CREDENTIAL = `
UPDATE staff_sessions
SET revoked_at = $3::timestamptz, challenge = NULL, challenge_purpose = NULL,
    challenge_expires_at = NULL, challenge_key_id = NULL
WHERE staff_id = $1::uuid AND second_factor_credential_id = $2::bytea AND revoked_at IS NULL`;

const LOCK_OWN_TOTP = `
SELECT algorithm FROM staff_totp_factors WHERE staff_id = $1::uuid FOR UPDATE`;

const DELETE_TOTP = `DELETE FROM staff_totp_factors WHERE staff_id = $1::uuid`;

/** Ends the sessions a removed TOTP factor let in (migration 030). */
const REVOKE_SESSIONS_BY_METHOD = `
UPDATE staff_sessions
SET revoked_at = $3::timestamptz, challenge = NULL, challenge_purpose = NULL,
    challenge_expires_at = NULL, challenge_key_id = NULL
WHERE staff_id = $1::uuid AND second_factor_method = $2::text AND revoked_at IS NULL`;

/** Off-boarding's lock: any member, live or disabled. */
const LOCK_ANY_MEMBER = `
SELECT (disabled_at IS NULL) AS live FROM staff_members WHERE id = $1::uuid FOR UPDATE`;

const DELETE_MEMBER_WEBAUTHN = `DELETE FROM staff_webauthn_credentials WHERE staff_id = $1::uuid`;

const DELETE_MEMBER_ROLES = `
DELETE FROM staff_role_grants WHERE staff_id = $1::uuid RETURNING role`;

const DISABLE_MEMBER = `
UPDATE staff_members SET disabled_at = $2::timestamptz
WHERE id = $1::uuid AND disabled_at IS NULL`;

const REVOKE_MEMBER_SESSIONS = `
UPDATE staff_sessions
SET revoked_at = $2::timestamptz, challenge = NULL, challenge_purpose = NULL,
    challenge_expires_at = NULL, challenge_key_id = NULL
WHERE staff_id = $1::uuid AND revoked_at IS NULL`;

const LOCKED_ROLES = `
SELECT role FROM staff_role_grants WHERE staff_id = $1::uuid ORDER BY role FOR UPDATE`;

const DELETE_ROLE = `DELETE FROM staff_role_grants WHERE staff_id = $1::uuid AND role = $2::text`;

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
  insertWebAuthn: INSERT_WEBAUTHN,
  listWebAuthn: LIST_WEBAUTHN,
  findWebAuthn: FIND_WEBAUTHN,
  advanceWebAuthnCount: ADVANCE_WEBAUTHN_COUNT,
  countSecondFactors: COUNT_SECOND_FACTORS,
  lockOwnWebAuthn: LOCK_OWN_WEBAUTHN,
  deleteWebAuthn: DELETE_WEBAUTHN,
  revokeSessionsByCredential: REVOKE_SESSIONS_BY_CREDENTIAL,
  disableMember: DISABLE_MEMBER,
  revokeMemberSessions: REVOKE_MEMBER_SESSIONS,
  lockOwnTotp: LOCK_OWN_TOTP,
  deleteTotp: DELETE_TOTP,
  revokeSessionsByMethod: REVOKE_SESSIONS_BY_METHOD,
  lockAnyMember: LOCK_ANY_MEMBER,
  deleteMemberWebAuthn: DELETE_MEMBER_WEBAUTHN,
  deleteMemberRoles: DELETE_MEMBER_ROLES,
  lockedRoles: LOCKED_ROLES,
  deleteRole: DELETE_ROLE,
  insertAudit: INSERT_AUDIT,
} as const;

/** WebAuthn §5.8.3's counter is an unsigned 32-bit integer. */
const MAX_SIGN_COUNT = 0xffffffff;

function checkSignCount(signCount: number): void {
  if (!Number.isSafeInteger(signCount) || signCount < 0 || signCount > MAX_SIGN_COUNT) {
    throw new RangeError('a WebAuthn signature counter is an unsigned 32-bit integer');
  }
}

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

    enrollWebAuthnCredential: (staffId, credential, recoveryCodeHashes, context) =>
      inTransaction(pool, async (client) => {
        checkSignCount(credential.signCount);
        for (const hash of recoveryCodeHashes ?? []) {
          if (hash.length !== 32) throw new TypeError('a recovery code hash is 32 bytes');
        }
        const live = await client.query(LOCK_LIVE_MEMBER, [staffId]);
        if (live.rowCount !== 1)
          throw new Error('cannot enroll a factor for an unknown or disabled member');
        const atIso = isoFromEpochMs(context.at);
        const inserted = await client.query(INSERT_WEBAUTHN, [
          Buffer.from(credential.credentialId),
          staffId,
          Buffer.from(credential.publicKeyCose),
          credential.algorithm,
          String(credential.signCount),
          credential.backupEligible,
          credential.label,
          atIso,
        ]);
        if (inserted.rowCount !== 1) return { kind: 'credential_taken' } as const;
        if (recoveryCodeHashes !== null) {
          await client.query(DELETE_RECOVERY_CODES, [staffId]);
          await client.query(INSERT_RECOVERY_CODES, [
            staffId,
            recoveryCodeHashes.map((hash) => Buffer.from(hash)),
            atIso,
          ]);
        }
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: context.actorId,
              action: 'staff.second_factor_enrolled',
              entity: { kind: 'staff_member', id: staffId },
              // The method and its shape, never the key or a code.
              after: {
                method: 'webauthn',
                algorithm: credential.algorithm,
                backupEligible: credential.backupEligible,
                recoveryCodes: recoveryCodeHashes?.length ?? null,
              },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return { kind: 'enrolled' } as const;
      }),

    async listWebAuthnCredentials(staffId) {
      const result = await pool.query(LIST_WEBAUTHN, [staffId]);
      return result.rows.map(decodeWebAuthn);
    },

    async findWebAuthnCredential(credentialId) {
      if (credentialId.length === 0) return null;
      const result = await pool.query(FIND_WEBAUTHN, [Buffer.from(credentialId)]);
      const [row] = result.rows;
      return row === undefined ? null : decodeWebAuthn(row);
    },

    async advanceWebAuthnSignCount(credentialId, signCount, at) {
      checkSignCount(signCount);
      const result = await pool.query(ADVANCE_WEBAUTHN_COUNT, [
        Buffer.from(credentialId),
        String(signCount),
        isoFromEpochMs(at),
      ]);
      return result.rowCount === 1;
    },

    async countSecondFactors(staffId) {
      const result = await pool.query(COUNT_SECOND_FACTORS, [staffId]);
      const [row] = result.rows;
      return row === undefined ? 0 : number(field(row, 'factors'), 'factors');
    },

    removeWebAuthnCredential: (staffId, credentialId, context) =>
      inTransaction(pool, async (client) => {
        if (credentialId.length === 0) return { kind: 'not_found' } as const;
        // The member's row lock serialises every removal and enrollment for them, so the
        // count below cannot be raced into zero by a concurrent removal.
        const live = await client.query(LOCK_LIVE_MEMBER, [staffId]);
        if (live.rowCount !== 1) return { kind: 'not_found' } as const;
        const id = Buffer.from(credentialId);
        const owned = await client.query(LOCK_OWN_WEBAUTHN, [id, staffId]);
        const [credential] = owned.rows;
        if (credential === undefined) return { kind: 'not_found' } as const;
        const counted = await client.query(COUNT_SECOND_FACTORS, [staffId]);
        const [countRow] = counted.rows;
        const factors = countRow === undefined ? 0 : number(field(countRow, 'factors'), 'factors');
        if (factors <= 1) return { kind: 'last_second_factor' } as const;
        const atIso = isoFromEpochMs(context.at);
        const deleted = await client.query(DELETE_WEBAUTHN, [id, staffId]);
        if (deleted.rowCount !== 1) throw new Error('credential delete did not remove one row');
        const revoked = await client.query(REVOKE_SESSIONS_BY_CREDENTIAL, [staffId, id, atIso]);
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: context.actorId,
              action: 'staff.second_factor_removed',
              entity: { kind: 'staff_member', id: staffId },
              // The method and its shape, never the key.
              before: {
                method: 'webauthn',
                algorithm: number(field(credential, 'algorithm'), 'algorithm'),
                backupEligible: boolean(field(credential, 'backup_eligible'), 'backup_eligible'),
              },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return { kind: 'removed', sessionsRevoked: revoked.rowCount ?? 0 } as const;
      }),

    removeTotpFactor: (staffId, context) =>
      inTransaction(pool, async (client) => {
        // The same lock as a credential removal: the count cannot be raced into zero.
        const live = await client.query(LOCK_LIVE_MEMBER, [staffId]);
        if (live.rowCount !== 1) return { kind: 'not_found' } as const;
        const owned = await client.query(LOCK_OWN_TOTP, [staffId]);
        const [factor] = owned.rows;
        if (factor === undefined) return { kind: 'not_found' } as const;
        const counted = await client.query(COUNT_SECOND_FACTORS, [staffId]);
        const [countRow] = counted.rows;
        const factors = countRow === undefined ? 0 : number(field(countRow, 'factors'), 'factors');
        if (factors <= 1) return { kind: 'last_second_factor' } as const;
        const atIso = isoFromEpochMs(context.at);
        const deleted = await client.query(DELETE_TOTP, [staffId]);
        if (deleted.rowCount !== 1) throw new Error('TOTP delete did not remove one row');
        const revoked = await client.query(REVOKE_SESSIONS_BY_METHOD, [staffId, 'totp', atIso]);
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: context.actorId,
              action: 'staff.second_factor_removed',
              entity: { kind: 'staff_member', id: staffId },
              // The method and its shape, never the secret.
              before: {
                method: 'totp',
                algorithm: string(field(factor, 'algorithm'), 'algorithm'),
              },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return { kind: 'removed', sessionsRevoked: revoked.rowCount ?? 0 } as const;
      }),

    offboardMember: (staffId, context) =>
      inTransaction(pool, async (client) => {
        const locked = await client.query(LOCK_ANY_MEMBER, [staffId]);
        const [member] = locked.rows;
        if (member === undefined) return { kind: 'not_found' } as const;
        const wasLive = boolean(field(member, 'live'), 'live');
        const atIso = isoFromEpochMs(context.at);
        if (wasLive) {
          const disabled = await client.query(DISABLE_MEMBER, [staffId, atIso]);
          if (disabled.rowCount !== 1) throw new Error('member disable did not change one row');
        }
        const sessions = await client.query(REVOKE_MEMBER_SESSIONS, [staffId, atIso]);
        const webauthn = await client.query(DELETE_MEMBER_WEBAUTHN, [staffId]);
        const totp = await client.query(DELETE_TOTP, [staffId]);
        const codes = await client.query(DELETE_RECOVERY_CODES, [staffId]);
        const roles = (await client.query(DELETE_MEMBER_ROLES, [staffId])).rows
          .map((row) => string(field(row, 'role'), 'role'))
          .filter(isStaffRole)
          .sort();
        const counts = {
          wasLive,
          sessionsRevoked: sessions.rowCount ?? 0,
          webauthnRemoved: webauthn.rowCount ?? 0,
          totpRemoved: totp.rowCount ?? 0,
          recoveryCodesRemoved: codes.rowCount ?? 0,
          rolesRemoved: roles,
        };
        if (
          !wasLive &&
          counts.sessionsRevoked === 0 &&
          counts.webauthnRemoved === 0 &&
          counts.totpRemoved === 0 &&
          counts.recoveryCodesRemoved === 0 &&
          roles.length === 0
        ) {
          return { kind: 'already_offboarded' } as const;
        }
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: context.actorId,
              action: 'staff.manage',
              entity: { kind: 'staff_member', id: staffId },
              // Counts and role names, never a key, a secret or a code.
              before: {
                disabled: !wasLive,
                webauthn: counts.webauthnRemoved,
                totp: counts.totpRemoved,
                recoveryCodes: counts.recoveryCodesRemoved,
                roles,
              },
              after: { disabled: true, offboarded: true, sessionsRevoked: counts.sessionsRevoked },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return { kind: 'offboarded', ...counts } as const;
      }),

    disableMember: (staffId, context) =>
      inTransaction(pool, async (client) => {
        const atIso = isoFromEpochMs(context.at);
        const disabled = await client.query(DISABLE_MEMBER, [staffId, atIso]);
        if (disabled.rowCount !== 1) return { kind: 'not_found' } as const;
        const revoked = await client.query(REVOKE_MEMBER_SESSIONS, [staffId, atIso]);
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: context.actorId,
              action: 'staff.manage',
              entity: { kind: 'staff_member', id: staffId },
              before: { disabled: false },
              after: { disabled: true },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return { kind: 'disabled', sessionsRevoked: revoked.rowCount ?? 0 } as const;
      }),

    setRoles: (staffId, roles, context) =>
      inTransaction(pool, async (client) => {
        const live = await client.query(LOCK_LIVE_MEMBER, [staffId]);
        if (live.rowCount !== 1) return { kind: 'not_found' } as const;
        const wanted = [...new Set(roles)].sort();
        const held = (await client.query(LOCKED_ROLES, [staffId])).rows.map((row) =>
          string(field(row, 'role'), 'role'),
        );
        const toAdd = wanted.filter((role) => !held.includes(role));
        const toDrop = held.filter((role) => !(wanted as readonly string[]).includes(role));
        if (toAdd.length === 0 && toDrop.length === 0) return { kind: 'unchanged' } as const;
        const atIso = isoFromEpochMs(context.at);
        for (const role of toDrop) await client.query(DELETE_ROLE, [staffId, role]);
        for (const role of toAdd) await client.query(INSERT_ROLE, [staffId, role, atIso]);
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: context.actorId,
              action: 'staff.manage',
              entity: { kind: 'staff_member', id: staffId },
              before: { roles: [...held].sort() },
              after: { roles: wanted },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return { kind: 'changed' } as const;
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

const WEBAUTHN_ALGORITHMS: readonly StoredWebAuthnAlgorithm[] = [-7, -8, -257];

function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} is not bytes`);
  return new Uint8Array(value);
}

function decodeWebAuthn(row: Record<string, unknown>): StoredWebAuthnCredential {
  const algorithm = number(field(row, 'algorithm'), 'algorithm');
  if (!(WEBAUTHN_ALGORITHMS as readonly number[]).includes(algorithm)) {
    throw new Error('algorithm holds a value outside the WebAuthn set');
  }
  const lastUsedAt = field(row, 'last_used_at');
  return {
    credentialId: bytes(field(row, 'credential_id'), 'credential_id'),
    staffId: string(field(row, 'staff_id'), 'staff_id'),
    publicKeyCose: bytes(field(row, 'public_key_cose'), 'public_key_cose'),
    algorithm: algorithm as StoredWebAuthnAlgorithm,
    signCount: seqFrom(field(row, 'sign_count'), 'sign_count'),
    backupEligible: boolean(field(row, 'backup_eligible'), 'backup_eligible'),
    label: string(field(row, 'label'), 'label'),
    enrolledAt: epochMs(field(row, 'enrolled_at'), 'enrolled_at'),
    lastUsedAt: lastUsedAt === null ? null : epochMs(lastUsedAt, 'last_used_at'),
  };
}
