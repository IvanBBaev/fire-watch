/**
 * The ports first-party sign-in needs (TASKS I1; 05 §5.4.1; migration 007).
 *
 * **Tokens cross these ports only as hashes.** A magic-link token and a session token are
 * bearer secrets; the database holds their SHA-256 (`token_hash`, 32 bytes, CHECKed), so a
 * leaked backup or an injected `SELECT` yields nothing that signs anyone in. The one place
 * a raw token exists is between {@link AuthTokens.mint} and the mail or the cookie it is
 * handed to.
 *
 * **Stores open no transactions.** The sign-in flows are written against these ports as
 * plain sequences; the pg adapter runs each flow inside one `BEGIN … COMMIT`, which is what
 * makes "count the last hour, supersede, insert" and "consume, then create a session"
 * atomic.
 *
 * Times cross as ISO-8601 strings on writes (the codebase's convention for timestamptz
 * binds) and as epoch milliseconds on reads (what the policy compares).
 */

import type { EpochMs } from './clock.js';

// ── Tokens ───────────────────────────────────────────────────────────────────────────

export interface MintedToken {
  /** The bearer secret: goes into the link or the cookie, never into the database. */
  readonly token: string;
  /** SHA-256 of `token`, 32 bytes: the only form that is stored. */
  readonly hash: Uint8Array;
}

/**
 * Randomness and hashing, which the core may not do itself (`server-core-has-no-platform`).
 * `hash` of a string that is not a well-formed token returns null rather than hashing it,
 * so a malformed cookie costs no database round trip.
 */
export interface AuthTokens {
  mint(): MintedToken;
  hash(token: string): Uint8Array | null;
  /** `crypto.randomUUID` in production. */
  newId(): string;
}

// ── Magic links ──────────────────────────────────────────────────────────────────────

export interface NewAuthLink {
  readonly id: string;
  readonly email: string;
  readonly tokenHash: Uint8Array;
  readonly uaFamily: string;
  readonly requestedAtIso: string;
  readonly expiresAtIso: string;
}

export interface StoredAuthLink {
  readonly id: string;
  readonly email: string;
  readonly uaFamily: string;
  readonly requestedAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly consumedAt: EpochMs | null;
  readonly supersededAt: EpochMs | null;
}

export interface AuthLinkStore {
  /**
   * Serializes issuance per address for the rest of the transaction, so two concurrent
   * requests cannot both count two and both insert a third.
   */
  lockAddress(email: string): Promise<void>;
  /** `requested_at` of every link issued to the address at or after `sinceIso`. */
  issuedSince(email: string, sinceIso: string): Promise<readonly EpochMs[]>;
  /** Marks every still-open link to the address superseded ("invalidated on new issuance"). */
  supersedeOpen(email: string, atIso: string): Promise<void>;
  insert(link: NewAuthLink): Promise<void>;
  findByTokenHash(tokenHash: Uint8Array): Promise<StoredAuthLink | null>;
  /**
   * Single use, enforced by the write itself: true only if this call is the one that moved
   * the row from open to consumed. A double-clicked "Continue" gets exactly one session.
   */
  consume(id: string, atIso: string): Promise<boolean>;
}

// ── Accounts ─────────────────────────────────────────────────────────────────────────

export interface AccountIdentityStore {
  /**
   * The live account for a verified address, created if there is none, with
   * `email_verified_at` set if it was not — consuming a magic link *is* the proof of
   * control. Returns the account id.
   */
  upsertVerified(
    email: string,
    atIso: string,
  ): Promise<{ readonly accountId: string; readonly created: boolean }>;
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────

export interface NewSession {
  readonly id: string;
  readonly tokenHash: Uint8Array;
  readonly accountId: string;
  readonly uaFamily: string;
  readonly createdAtIso: string;
  readonly expiresAtIso: string;
}

export interface StoredSession {
  readonly id: string;
  readonly accountId: string;
  readonly expiresAt: EpochMs;
  readonly revokedAt: EpochMs | null;
  /** True when the owning account is soft-deleted; such a session authenticates nothing. */
  readonly accountDeleted: boolean;
}

export interface SessionStore {
  insert(session: NewSession): Promise<void>;
  findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null>;
  /** The sliding expiry: `last_seen_at` and `expires_at` move together. */
  touch(id: string, lastSeenIso: string, expiresAtIso: string): Promise<void>;
  revoke(id: string, atIso: string): Promise<void>;
  /** "Log out everywhere", and the first step of a takeover response. Returns the count. */
  revokeAllForAccount(accountId: string, atIso: string): Promise<number>;
}

// ── Mail ─────────────────────────────────────────────────────────────────────────────

/**
 * The sign-in mail. A port with **no implementation yet**: the sender, the auth-mail
 * subdomain (§5.5.3) and the landing URL's shape are founder decisions (see the I1 report).
 *
 * Deliberately not an alert channel: alert sends go through the gateway
 * (`only-the-gateway-sends`), whose suppression, budgets and kill switch must never stand
 * between a user and signing in — and a sign-in mail is not a notification about a fire.
 *
 * The adapter builds the URL. The recommendation in the report is to carry the token in
 * the URL *fragment*, which browsers never send to a server — so it cannot reach an
 * access log, a `Referer`, or a mail scanner's GET — and have the landing page POST it on
 * "Continue".
 */
export interface AuthMailer {
  sendSignInLink(message: {
    readonly to: string;
    readonly token: string;
    readonly expiresAtIso: string;
  }): Promise<void>;
}
