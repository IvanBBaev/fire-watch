/**
 * The staff plane's sessions over Postgres (TASKS I1; 05 C3, §5.4.3; migration 029).
 *
 * **One answer per challenge.** {@link StaffSessionStore.takeChallenge} locks the row with
 * `FOR UPDATE` only while it still holds a challenge and clears it in the same statement;
 * a second request racing for the same challenge waits on the lock, re-reads the row, sees
 * no challenge and gets nothing.
 *
 * **Elevation is a compare-and-set.** {@link StaffSessionStore.markSecondFactor} lands only
 * on a session that is unrevoked, unexpired, still pending and whose member is live, and it
 * swaps `token_hash` in the same UPDATE, so the pre-elevation cookie stops working at the
 * moment the session gains powers. For WebAuthn it first takes a share lock on the
 * credential, so a removal of that credential either finishes first (and the elevation
 * finds no credential) or waits and then revokes the session it just elevated. The
 * `staff.sign_in` audit row is written in the same transaction.
 *
 * **Wrong codes are counted** (migration 030). {@link StaffSessionStore.recordSecondFactorFailure}
 * increments `second_factor_failures` on a pending, unrevoked session and, when the new
 * count reaches the limit, revokes it in the same UPDATE — the row lock serialises racing
 * guesses, so the cap cannot be overshot by parallel requests. The lockout is audited.
 */

import { isoFromEpochMs } from '../../core/ports/clock.js';
import type { StaffSessionStore, StoredStaffSession } from '../../core/ports/staff-stores.js';
import { buildStaffAuditRecord } from '../../core/staff/staff-audit.js';
import { isStaffRole, type StaffRole } from '../../core/staff/staff-policy.js';
import {
  STAFF_CHALLENGE_PURPOSES,
  STAFF_SECOND_FACTOR_METHODS,
  type StaffChallengePurpose,
  type StaffSecondFactorMethod,
  type StoredChallenge,
} from '../../core/staff/staff-session-policy.js';
import { epochMs, field, number, string } from './pg-rows.js';
import { inTransaction, insertAuditRecord, sha256Hex, type PgStaffPool } from './pg-staff-store.js';

const INSERT_SESSION = `
INSERT INTO staff_sessions
  (id, token_hash, staff_id, ua_family, created_at, last_seen_at, idle_expires_at,
   absolute_expires_at)
VALUES ($1::uuid, $2::bytea, $3::uuid, $4::text, $5::timestamptz, $5::timestamptz,
        $6::timestamptz, $7::timestamptz)`;

const FIND_BY_TOKEN = `
SELECT s.id::text AS id, s.staff_id::text AS staff_id, s.ua_family, s.created_at,
       s.last_seen_at, s.idle_expires_at, s.absolute_expires_at, s.second_factor_method,
       s.second_factor_credential_id, s.second_factor_at, s.revoked_at,
       (m.disabled_at IS NOT NULL) AS member_disabled,
       COALESCE((SELECT array_agg(g.role ORDER BY g.role)
                 FROM staff_role_grants g WHERE g.staff_id = s.staff_id), '{}') AS roles
FROM staff_sessions s
JOIN staff_members m ON m.id = s.staff_id
WHERE s.token_hash = $1::bytea`;

const TOUCH = `
UPDATE staff_sessions
SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz),
    idle_expires_at = LEAST($3::timestamptz, absolute_expires_at)
WHERE id = $1::uuid AND revoked_at IS NULL`;

const PUT_CHALLENGE = `
UPDATE staff_sessions s
SET challenge = $2::bytea, challenge_purpose = $3::text, challenge_expires_at = $4::timestamptz
FROM staff_members m
WHERE s.id = $1::uuid AND m.id = s.staff_id AND m.disabled_at IS NULL
  AND s.revoked_at IS NULL
  AND s.idle_expires_at > $5::timestamptz AND s.absolute_expires_at > $5::timestamptz`;

/** The lock is taken only on a row that still holds a challenge; the loser re-reads none. */
const TAKE_CHALLENGE = `
WITH taken AS (
  SELECT id, challenge, challenge_purpose, challenge_expires_at
  FROM staff_sessions
  WHERE id = $1::uuid AND challenge IS NOT NULL
  FOR UPDATE
)
UPDATE staff_sessions s
SET challenge = NULL, challenge_purpose = NULL, challenge_expires_at = NULL
FROM taken
WHERE s.id = taken.id
RETURNING taken.challenge, taken.challenge_purpose, taken.challenge_expires_at`;

const SHARE_CREDENTIAL = `
SELECT 1 FROM staff_webauthn_credentials c
JOIN staff_sessions s ON s.staff_id = c.staff_id
WHERE c.credential_id = $1::bytea AND s.id = $2::uuid
FOR SHARE OF c`;

const MARK_SECOND_FACTOR = `
UPDATE staff_sessions s
SET second_factor_method = $2::text, second_factor_credential_id = $3::bytea,
    second_factor_at = $5::timestamptz, token_hash = $4::bytea,
    idle_expires_at = LEAST($6::timestamptz, s.absolute_expires_at),
    last_seen_at = GREATEST(s.last_seen_at, $5::timestamptz),
    challenge = NULL, challenge_purpose = NULL, challenge_expires_at = NULL
FROM staff_members m
WHERE s.id = $1::uuid AND m.id = s.staff_id AND m.disabled_at IS NULL
  AND s.revoked_at IS NULL AND s.second_factor_at IS NULL
  AND s.idle_expires_at > $5::timestamptz AND s.absolute_expires_at > $5::timestamptz
RETURNING s.staff_id::text AS staff_id`;

const REVOKE = `
UPDATE staff_sessions
SET revoked_at = $2::timestamptz, challenge = NULL, challenge_purpose = NULL,
    challenge_expires_at = NULL
WHERE id = $1::uuid AND revoked_at IS NULL
RETURNING staff_id::text AS staff_id, (second_factor_at IS NOT NULL) AS verified`;

/** The count and the revocation are one statement; SET reads the pre-update row. */
const RECORD_FAILURE = `
UPDATE staff_sessions
SET second_factor_failures = second_factor_failures + 1,
    revoked_at = CASE WHEN second_factor_failures + 1 >= $2::integer THEN $3::timestamptz END,
    challenge = CASE WHEN second_factor_failures + 1 >= $2::integer THEN NULL ELSE challenge END,
    challenge_purpose =
      CASE WHEN second_factor_failures + 1 >= $2::integer THEN NULL ELSE challenge_purpose END,
    challenge_expires_at =
      CASE WHEN second_factor_failures + 1 >= $2::integer THEN NULL ELSE challenge_expires_at END
WHERE id = $1::uuid AND revoked_at IS NULL AND second_factor_at IS NULL
RETURNING staff_id::text AS staff_id, second_factor_failures AS failures,
          (revoked_at IS NOT NULL) AS revoked`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const STAFF_SESSION_SQL = {
  insert: INSERT_SESSION,
  findByToken: FIND_BY_TOKEN,
  touch: TOUCH,
  putChallenge: PUT_CHALLENGE,
  takeChallenge: TAKE_CHALLENGE,
  shareCredential: SHARE_CREDENTIAL,
  markSecondFactor: MARK_SECOND_FACTOR,
  recordFailure: RECORD_FAILURE,
  revoke: REVOKE,
} as const;

function checkTokenHash(hash: Uint8Array): void {
  if (hash.length !== 32) throw new TypeError('a staff session token hash is 32 bytes');
}

export function createPgStaffSessionStore(pool: PgStaffPool): StaffSessionStore {
  return {
    async insert(session) {
      checkTokenHash(session.tokenHash);
      await pool.query(INSERT_SESSION, [
        session.id,
        Buffer.from(session.tokenHash),
        session.staffId,
        session.uaFamily,
        isoFromEpochMs(session.at),
        isoFromEpochMs(session.idleExpiresAt),
        isoFromEpochMs(session.absoluteExpiresAt),
      ]);
    },

    async findByTokenHash(tokenHash) {
      if (tokenHash.length !== 32) return null;
      const result = await pool.query(FIND_BY_TOKEN, [Buffer.from(tokenHash)]);
      const [row] = result.rows;
      return row === undefined ? null : decodeSession(row);
    },

    async touch(sessionId, at, idleExpiresAt) {
      const result = await pool.query(TOUCH, [
        sessionId,
        isoFromEpochMs(at),
        isoFromEpochMs(idleExpiresAt),
      ]);
      return result.rowCount === 1;
    },

    async putChallenge(sessionId, challenge, at) {
      if (challenge.challenge.length < 16 || challenge.challenge.length > 64) {
        throw new RangeError('a WebAuthn challenge is 16 to 64 bytes');
      }
      const result = await pool.query(PUT_CHALLENGE, [
        sessionId,
        Buffer.from(challenge.challenge),
        challenge.purpose,
        isoFromEpochMs(challenge.expiresAt),
        isoFromEpochMs(at),
      ]);
      return result.rowCount === 1;
    },

    async takeChallenge(sessionId) {
      const result = await pool.query(TAKE_CHALLENGE, [sessionId]);
      const [row] = result.rows;
      return row === undefined ? null : decodeChallenge(row);
    },

    markSecondFactor: (sessionId, input, context) =>
      inTransaction(pool, async (client) => {
        checkTokenHash(input.newTokenHash);
        if ((input.credentialId !== null) !== (input.method === 'webauthn')) {
          throw new TypeError('a WebAuthn elevation names its credential, and only it does');
        }
        if (input.credentialId !== null) {
          const shared = await client.query(SHARE_CREDENTIAL, [
            Buffer.from(input.credentialId),
            sessionId,
          ]);
          if (shared.rowCount !== 1) return false;
        }
        const marked = await client.query(MARK_SECOND_FACTOR, [
          sessionId,
          input.method,
          input.credentialId === null ? null : Buffer.from(input.credentialId),
          Buffer.from(input.newTokenHash),
          isoFromEpochMs(context.at),
          isoFromEpochMs(input.idleExpiresAt),
        ]);
        const [row] = marked.rows;
        if (row === undefined) return false;
        const staffId = string(field(row, 'staff_id'), 'staff_id');
        await insertAuditRecord(
          client,
          buildStaffAuditRecord(
            {
              actorId: staffId,
              action: 'staff.sign_in',
              entity: { kind: 'staff_session', id: sessionId },
              after: { method: input.method },
              ...(context.ip === undefined ? {} : { ip: context.ip }),
              at: context.at,
            },
            sha256Hex,
          ),
        );
        return true;
      }),

    recordSecondFactorFailure: (sessionId, limit, context) =>
      inTransaction(pool, async (client) => {
        if (!Number.isSafeInteger(limit) || limit < 1) {
          throw new RangeError('a second-factor failure limit is a positive integer');
        }
        const counted = await client.query(RECORD_FAILURE, [
          sessionId,
          limit,
          isoFromEpochMs(context.at),
        ]);
        const [row] = counted.rows;
        if (row === undefined) return null;
        const failures = number(field(row, 'failures'), 'failures');
        const revoked = field(row, 'revoked') === true;
        if (revoked) {
          // A pending session never signed in on the trail, but a lockout is evidence of
          // guessing, so it is recorded.
          await insertAuditRecord(
            client,
            buildStaffAuditRecord(
              {
                actorId: string(field(row, 'staff_id'), 'staff_id'),
                action: 'staff.sign_out',
                entity: { kind: 'staff_session', id: sessionId },
                after: { reason: 'too_many_second_factor_failures', failures },
                ...(context.ip === undefined ? {} : { ip: context.ip }),
                at: context.at,
              },
              sha256Hex,
            ),
          );
        }
        return { failures, revoked };
      }),

    revoke: (sessionId, context) =>
      inTransaction(pool, async (client) => {
        const revoked = await client.query(REVOKE, [sessionId, isoFromEpochMs(context.at)]);
        const [row] = revoked.rows;
        if (row === undefined) return false;
        // A session that never passed its second factor never signed in on the trail, so
        // its end is not recorded either.
        if (field(row, 'verified') === true) {
          await insertAuditRecord(
            client,
            buildStaffAuditRecord(
              {
                actorId: string(field(row, 'staff_id'), 'staff_id'),
                action: 'staff.sign_out',
                entity: { kind: 'staff_session', id: sessionId },
                ...(context.ip === undefined ? {} : { ip: context.ip }),
                at: context.at,
              },
              sha256Hex,
            ),
          );
        }
        return true;
      }),
  };
}

function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} is not bytes`);
  return new Uint8Array(value);
}

function nullableEpochMs(value: unknown, name: string): number | null {
  return value === null ? null : epochMs(value, name);
}

function decodeSession(row: Record<string, unknown>): StoredStaffSession {
  const rawRoles = field(row, 'roles');
  if (!Array.isArray(rawRoles)) throw new Error('roles is not an array');
  // An unknown role is a newer migration than this build; granting nothing is the safe read.
  const roles: StaffRole[] = rawRoles.filter(isStaffRole);
  const disabled = field(row, 'member_disabled');
  if (typeof disabled !== 'boolean') throw new Error('member_disabled is not a boolean');
  const method = field(row, 'second_factor_method');
  if (method !== null && !(STAFF_SECOND_FACTOR_METHODS as readonly unknown[]).includes(method)) {
    throw new Error('second_factor_method holds a value outside the method set');
  }
  const credentialId = field(row, 'second_factor_credential_id');
  return {
    id: string(field(row, 'id'), 'id'),
    staffId: string(field(row, 'staff_id'), 'staff_id'),
    uaFamily: string(field(row, 'ua_family'), 'ua_family'),
    roles,
    memberDisabled: disabled,
    createdAt: epochMs(field(row, 'created_at'), 'created_at'),
    lastSeenAt: epochMs(field(row, 'last_seen_at'), 'last_seen_at'),
    idleExpiresAt: epochMs(field(row, 'idle_expires_at'), 'idle_expires_at'),
    absoluteExpiresAt: epochMs(field(row, 'absolute_expires_at'), 'absolute_expires_at'),
    secondFactorMethod: method as StaffSecondFactorMethod | null,
    secondFactorCredentialId:
      credentialId === null ? null : bytes(credentialId, 'second_factor_credential_id'),
    secondFactorAt: nullableEpochMs(field(row, 'second_factor_at'), 'second_factor_at'),
    revokedAt: nullableEpochMs(field(row, 'revoked_at'), 'revoked_at'),
  };
}

function decodeChallenge(row: Record<string, unknown>): StoredChallenge {
  const purpose = string(field(row, 'challenge_purpose'), 'challenge_purpose');
  if (!(STAFF_CHALLENGE_PURPOSES as readonly string[]).includes(purpose)) {
    throw new Error('challenge_purpose holds a value outside the purpose set');
  }
  return {
    purpose: purpose as StaffChallengePurpose,
    challenge: bytes(field(row, 'challenge'), 'challenge'),
    expiresAt: epochMs(field(row, 'challenge_expires_at'), 'challenge_expires_at'),
  };
}
