/**
 * First-party sign-in over Postgres (TASKS I1; 05 §5.4.1; migration 007): the three stores,
 * and the flows from `core/auth/sign-in.ts` bound to them with the transactions they need.
 *
 * **Which flows are transactions, and why.**
 *
 *   * Requesting a link: `lockAddress` takes a transaction-scoped advisory lock on the
 *     address, so "count the last hour, supersede, insert" cannot interleave with a second
 *     request for the same address — without it, two concurrent requests would each count
 *     two and each insert a third, and C2's limit would be a suggestion. The mail is sent
 *     inside the transaction too: if the mailer throws, the row rolls back and the attempt
 *     does not use up one of the address's three.
 *   * Continuing a link: consume, upsert the account, insert the session — one unit, so a
 *     consumed link always has its session, and a failed session insert leaves the link
 *     usable for a retry inside its fifteen minutes.
 *   * Authenticating and signing out are single statements each (plus a read) and run on
 *     the pool; the touch is guarded with `GREATEST` so two concurrent requests from one
 *     browser can only ever move the expiry forward.
 *
 * Tokens reach this module as SHA-256 hashes only (`bytea`, 32 bytes, CHECKed by 007).
 */

import type { EpochMs } from '../../core/ports/clock.js';
import type {
  AccountIdentityStore,
  AuthLinkStore,
  AuthMailer,
  AuthTokens,
  SessionStore,
  StoredAuthLink,
  StoredSession,
} from '../../core/ports/auth-stores.js';
import {
  authenticateSession,
  continueSignIn,
  requestSignInLink,
  signOut,
  type AuthenticatedSession,
  type StartedSession,
} from '../../core/auth/sign-in.js';
import { boolean, epochMs, field, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgAuthQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgAuthClient extends PgAuthQueryable {
  release(): void;
}

export interface PgAuthPool extends PgAuthQueryable {
  connect(): Promise<PgAuthClient>;
}

/**
 * The advisory-lock class for sign-in issuance. The two-key form keeps this lock space
 * apart from any other advisory lock the codebase takes later; `hashtext` collisions only
 * ever over-serialize two addresses, never under-serialize one.
 */
export const AUTH_LINK_LOCK_CLASS = 7007;

const LOCK_ADDRESS = `SELECT pg_advisory_xact_lock(${AUTH_LINK_LOCK_CLASS}, hashtext($1::text))`;

const ISSUED_SINCE = `
SELECT requested_at
FROM auth_link_requests
WHERE email = $1::text AND requested_at >= $2::timestamptz
ORDER BY requested_at`;

const SUPERSEDE_OPEN = `
UPDATE auth_link_requests
SET superseded_at = $2::timestamptz
WHERE email = $1::text AND consumed_at IS NULL AND superseded_at IS NULL`;

const INSERT_LINK = `
INSERT INTO auth_link_requests (id, email, token_hash, ua_family, requested_at, expires_at)
VALUES ($1::uuid, $2::text, $3::bytea, $4::text, $5::timestamptz, $6::timestamptz)`;

const FIND_LINK = `
SELECT id::text AS id, email, ua_family, requested_at, expires_at, consumed_at, superseded_at
FROM auth_link_requests
WHERE token_hash = $1::bytea`;

/** The conditions repeat the policy's on purpose: the write itself is the single-use guard. */
const CONSUME_LINK = `
UPDATE auth_link_requests
SET consumed_at = $2::timestamptz
WHERE id = $1::uuid
  AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > $2::timestamptz`;

/**
 * Against 007's partial unique index `accounts_email_live`, so a deleted account's address
 * starts a fresh account rather than resurrecting the old one. `xmax = 0` is true exactly
 * for a row this statement inserted.
 */
const UPSERT_VERIFIED_ACCOUNT = `
INSERT INTO accounts (email, email_verified_at, created_at)
VALUES ($1::text, $2::timestamptz, $2::timestamptz)
ON CONFLICT (email) WHERE deleted_at IS NULL AND email IS NOT NULL
DO UPDATE SET email_verified_at = COALESCE(accounts.email_verified_at, EXCLUDED.email_verified_at)
RETURNING id::text AS id, (xmax = 0) AS created`;

const INSERT_SESSION = `
INSERT INTO account_sessions (id, token_hash, account_id, ua_family, created_at, last_seen_at, expires_at)
VALUES ($1::uuid, $2::bytea, $3::uuid, $4::text, $5::timestamptz, $5::timestamptz, $6::timestamptz)`;

const FIND_SESSION = `
SELECT
  s.id::text AS id,
  s.account_id::text AS account_id,
  s.expires_at,
  s.revoked_at,
  (a.deleted_at IS NOT NULL) AS account_deleted
FROM account_sessions s
JOIN accounts a ON a.id = s.account_id
WHERE s.token_hash = $1::bytea`;

const TOUCH_SESSION = `
UPDATE account_sessions
SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz),
    expires_at = GREATEST(expires_at, $3::timestamptz)
WHERE id = $1::uuid AND revoked_at IS NULL`;

const REVOKE_SESSION = `
UPDATE account_sessions
SET revoked_at = $2::timestamptz
WHERE id = $1::uuid AND revoked_at IS NULL`;

const REVOKE_ALL_FOR_ACCOUNT = `
UPDATE account_sessions
SET revoked_at = $2::timestamptz
WHERE account_id = $1::uuid AND revoked_at IS NULL`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const AUTH_SQL = {
  lockAddress: LOCK_ADDRESS,
  issuedSince: ISSUED_SINCE,
  supersedeOpen: SUPERSEDE_OPEN,
  insertLink: INSERT_LINK,
  findLink: FIND_LINK,
  consumeLink: CONSUME_LINK,
  upsertVerifiedAccount: UPSERT_VERIFIED_ACCOUNT,
  insertSession: INSERT_SESSION,
  findSession: FIND_SESSION,
  touchSession: TOUCH_SESSION,
  revokeSession: REVOKE_SESSION,
  revokeAllForAccount: REVOKE_ALL_FOR_ACCOUNT,
} as const;

export function createPgAuthLinkStore(db: PgAuthQueryable): AuthLinkStore {
  return {
    async lockAddress(email) {
      await db.query(LOCK_ADDRESS, [email]);
    },
    async issuedSince(email, sinceIso) {
      const result = await db.query(ISSUED_SINCE, [email, sinceIso]);
      return result.rows.map((row) => epochMs(field(row, 'requested_at'), 'requested_at'));
    },
    async supersedeOpen(email, atIso) {
      await db.query(SUPERSEDE_OPEN, [email, atIso]);
    },
    async insert(link) {
      const result = await db.query(INSERT_LINK, [
        link.id,
        link.email,
        Buffer.from(link.tokenHash),
        link.uaFamily,
        link.requestedAtIso,
        link.expiresAtIso,
      ]);
      if (result.rowCount !== 1) throw new Error('auth link insert did not write exactly one row');
    },
    async findByTokenHash(tokenHash) {
      const result = await db.query(FIND_LINK, [Buffer.from(tokenHash)]);
      const [row] = result.rows;
      return row === undefined ? null : decodeLink(row);
    },
    async consume(id, atIso) {
      const result = await db.query(CONSUME_LINK, [id, atIso]);
      return result.rowCount === 1;
    },
  };
}

export function createPgAccountIdentityStore(db: PgAuthQueryable): AccountIdentityStore {
  return {
    async upsertVerified(email, atIso) {
      const result = await db.query(UPSERT_VERIFIED_ACCOUNT, [email, atIso]);
      const [row] = result.rows;
      if (row === undefined) throw new Error('account upsert returned no row');
      return {
        accountId: string(field(row, 'id'), 'id'),
        created: boolean(field(row, 'created'), 'created'),
      };
    },
  };
}

export function createPgSessionStore(db: PgAuthQueryable): SessionStore {
  return {
    async insert(session) {
      const result = await db.query(INSERT_SESSION, [
        session.id,
        Buffer.from(session.tokenHash),
        session.accountId,
        session.uaFamily,
        session.createdAtIso,
        session.expiresAtIso,
      ]);
      if (result.rowCount !== 1) throw new Error('session insert did not write exactly one row');
    },
    async findByTokenHash(tokenHash) {
      const result = await db.query(FIND_SESSION, [Buffer.from(tokenHash)]);
      const [row] = result.rows;
      return row === undefined ? null : decodeSession(row);
    },
    async touch(id, lastSeenIso, expiresAtIso) {
      await db.query(TOUCH_SESSION, [id, lastSeenIso, expiresAtIso]);
    },
    async revoke(id, atIso) {
      await db.query(REVOKE_SESSION, [id, atIso]);
    },
    async revokeAllForAccount(accountId, atIso) {
      const result = await db.query(REVOKE_ALL_FOR_ACCOUNT, [accountId, atIso]);
      return result.rowCount ?? 0;
    },
  };
}

// ── The flows, with their transactions ───────────────────────────────────────────────

export interface PgSignInFlows {
  requestLink(
    request: { readonly email: string; readonly userAgent: string | undefined },
    at: EpochMs,
  ): Promise<void>;
  continueLink(
    request: { readonly token: string; readonly userAgent: string | undefined },
    at: EpochMs,
  ): Promise<StartedSession>;
  authenticate(sessionToken: string | undefined, at: EpochMs): Promise<AuthenticatedSession | null>;
  signOut(sessionToken: string | undefined, at: EpochMs): Promise<void>;
}

export function createPgSignInFlows(
  pool: PgAuthPool,
  options: { readonly tokens: AuthTokens; readonly mailer: AuthMailer },
): PgSignInFlows {
  const sessionDeps = { sessions: createPgSessionStore(pool), tokens: options.tokens };
  return {
    requestLink: (request, at) =>
      inTransaction(pool, (client) =>
        requestSignInLink(request, at, {
          links: createPgAuthLinkStore(client),
          tokens: options.tokens,
          mailer: options.mailer,
        }),
      ),
    continueLink: (request, at) =>
      inTransaction(pool, (client) =>
        continueSignIn(request, at, {
          links: createPgAuthLinkStore(client),
          accounts: createPgAccountIdentityStore(client),
          sessions: createPgSessionStore(client),
          tokens: options.tokens,
        }),
      ),
    authenticate: (sessionToken, at) => authenticateSession(sessionToken, at, sessionDeps),
    signOut: (sessionToken, at) => signOut(sessionToken, at, sessionDeps),
  };
}

/** Same shape as `pg-zone-creation.ts`: ROLLBACK's own failure never masks the original. */
async function inTransaction<T>(
  pool: PgAuthPool,
  work: (client: PgAuthClient) => Promise<T>,
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

function nullableEpochMs(value: unknown, name: string): EpochMs | null {
  return value === null ? null : epochMs(value, name);
}

function decodeLink(row: Record<string, unknown>): StoredAuthLink {
  return {
    id: string(field(row, 'id'), 'id'),
    email: string(field(row, 'email'), 'email'),
    uaFamily: string(field(row, 'ua_family'), 'ua_family'),
    requestedAt: epochMs(field(row, 'requested_at'), 'requested_at'),
    expiresAt: epochMs(field(row, 'expires_at'), 'expires_at'),
    consumedAt: nullableEpochMs(field(row, 'consumed_at'), 'consumed_at'),
    supersededAt: nullableEpochMs(field(row, 'superseded_at'), 'superseded_at'),
  };
}

function decodeSession(row: Record<string, unknown>): StoredSession {
  return {
    id: string(field(row, 'id'), 'id'),
    accountId: string(field(row, 'account_id'), 'account_id'),
    expiresAt: epochMs(field(row, 'expires_at'), 'expires_at'),
    revokedAt: nullableEpochMs(field(row, 'revoked_at'), 'revoked_at'),
    accountDeleted: boolean(field(row, 'account_deleted'), 'account_deleted'),
  };
}
