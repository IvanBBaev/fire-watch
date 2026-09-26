/**
 * The first-party sign-in flows (TASKS I1; 05 §5.4.1 C1–C2): request a magic link,
 * "Continue" it into a session, authenticate a request by its session, sign out.
 *
 * Each flow is a plain sequence over the ports in `ports/auth-stores.ts`. The pg adapter
 * (`adapters/db/pg-auth.ts`) runs {@link requestSignInLink} and {@link continueSignIn}
 * each inside one transaction; nothing here knows that, and nothing here reads a clock —
 * `at` is always passed in.
 *
 * **What a caller learns, and what it does not.** A link request for a well-formed address
 * always answers the same way whether or not an account exists, so the endpoint is not an
 * account oracle. The one refusal it can see is the per-address rate limit, which says
 * nothing about existence either: it counts requests, not accounts.
 */

import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type {
  AccountIdentityStore,
  AuthLinkStore,
  AuthMailer,
  AuthTokens,
  SessionStore,
} from '../ports/auth-stores.js';
import {
  AUTH_POLICY,
  decideLinkIssue,
  evaluateLink,
  isSessionLive,
  normalizeEmail,
  slidingExpiry,
  uaFamily,
  type LinkRefusal,
} from './auth-policy.js';

export type AuthRefusalCode = 'invalid_email' | 'rate_limited' | LinkRefusal;

/** A refusal the route maps to a problem document. Messages are literals: no address, no token. */
export class AuthRefusal extends Error {
  readonly code: AuthRefusalCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: AuthRefusalCode, retryAfterSeconds?: number) {
    super(`sign-in refused: ${code}`);
    this.name = 'AuthRefusal';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ── Request a link ───────────────────────────────────────────────────────────────────

export interface RequestSignInLinkDeps {
  readonly links: AuthLinkStore;
  readonly tokens: AuthTokens;
  readonly mailer: AuthMailer;
}

/**
 * Issues a link, or refuses. The order is the rule: lock the address, count its last hour
 * (C2: three), supersede whatever is still open (§5.4.1: "invalidated on new issuance"),
 * insert, and only then mail — so a mail failure inside the adapter's transaction rolls the
 * row back and does not use up one of the address's three.
 */
export async function requestSignInLink(
  request: { readonly email: string; readonly userAgent: string | undefined },
  at: EpochMs,
  deps: RequestSignInLinkDeps,
): Promise<void> {
  const email = normalizeEmail(request.email);
  if (email === null) throw new AuthRefusal('invalid_email');

  await deps.links.lockAddress(email);
  const recent = await deps.links.issuedSince(
    email,
    isoFromEpochMs(at - AUTH_POLICY.linkIssueWindowMs),
  );
  const decision = decideLinkIssue(recent, at);
  if (!decision.allowed) throw new AuthRefusal('rate_limited', decision.retryAfterSeconds);

  const atIso = isoFromEpochMs(at);
  await deps.links.supersedeOpen(email, atIso);
  const minted = deps.tokens.mint();
  const expiresAtIso = isoFromEpochMs(decision.expiresAt);
  await deps.links.insert({
    id: deps.tokens.newId(),
    email,
    tokenHash: minted.hash,
    uaFamily: uaFamily(request.userAgent),
    requestedAtIso: atIso,
    expiresAtIso,
  });
  await deps.mailer.sendSignInLink({ to: email, token: minted.token, expiresAtIso });
}

// ── Continue ─────────────────────────────────────────────────────────────────────────

export interface ContinueSignInDeps {
  readonly links: AuthLinkStore;
  readonly accounts: AccountIdentityStore;
  readonly sessions: SessionStore;
  readonly tokens: AuthTokens;
}

export interface StartedSession {
  /** The cookie value. Returned once, here, and never stored. */
  readonly sessionToken: string;
  readonly sessionId: string;
  readonly accountId: string;
  readonly accountCreated: boolean;
  readonly expiresAt: EpochMs;
}

/**
 * The "Continue" click (a POST — never the GET a mail scanner prefetches). Consumes the
 * link, finds or creates the account behind the now-verified address, and starts a session
 * bound to nothing but its own row.
 *
 * `consume` is a conditional write, so a race between two clicks — or a click and a
 * supersede — yields one session and one `used` refusal, never two sessions.
 */
export async function continueSignIn(
  request: { readonly token: string; readonly userAgent: string | undefined },
  at: EpochMs,
  deps: ContinueSignInDeps,
): Promise<StartedSession> {
  const hash = deps.tokens.hash(request.token);
  if (hash === null) throw new AuthRefusal('unknown');
  const link = await deps.links.findByTokenHash(hash);
  const family = uaFamily(request.userAgent);
  const refusal = evaluateLink(link, family, at);
  if (refusal !== null || link === null) throw new AuthRefusal(refusal ?? 'unknown');

  const atIso = isoFromEpochMs(at);
  if (!(await deps.links.consume(link.id, atIso))) throw new AuthRefusal('used');

  const { accountId, created } = await deps.accounts.upsertVerified(link.email, atIso);
  const minted = deps.tokens.mint();
  const sessionId = deps.tokens.newId();
  const expiresAt = slidingExpiry(at);
  await deps.sessions.insert({
    id: sessionId,
    tokenHash: minted.hash,
    accountId,
    uaFamily: family,
    createdAtIso: atIso,
    expiresAtIso: isoFromEpochMs(expiresAt),
  });
  return { sessionToken: minted.token, sessionId, accountId, accountCreated: created, expiresAt };
}

// ── Authenticate, sign out ───────────────────────────────────────────────────────────

export interface SessionDeps {
  readonly sessions: SessionStore;
  readonly tokens: AuthTokens;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly accountId: string;
  /** The new, slid expiry — the route re-issues the cookie with it. */
  readonly expiresAt: EpochMs;
}

/**
 * Resolves a session cookie to an account, or null. A live session is touched — its
 * expiry slides to thirty days from `at` — on every call; whether to throttle that write
 * is a founder decision (see the I1 report).
 *
 * The UA family is recorded on the session for the account screen and is *not* checked
 * here: 05 binds the link to the family, not the session, and a browser that updates
 * itself mid-session must not be signed out by it.
 */
export async function authenticateSession(
  sessionToken: string | undefined,
  at: EpochMs,
  deps: SessionDeps,
): Promise<AuthenticatedSession | null> {
  if (sessionToken === undefined) return null;
  const hash = deps.tokens.hash(sessionToken);
  if (hash === null) return null;
  const session = await deps.sessions.findByTokenHash(hash);
  if (session === null || session.accountDeleted || !isSessionLive(session, at)) return null;
  const expiresAt = slidingExpiry(at);
  await deps.sessions.touch(session.id, isoFromEpochMs(at), isoFromEpochMs(expiresAt));
  return { sessionId: session.id, accountId: session.accountId, expiresAt };
}

/** Revokes the row (C1: "takeover response is 'revoke row'"). Idempotent; unknown is fine. */
export async function signOut(
  sessionToken: string | undefined,
  at: EpochMs,
  deps: SessionDeps,
): Promise<void> {
  if (sessionToken === undefined) return;
  const hash = deps.tokens.hash(sessionToken);
  if (hash === null) return;
  const session = await deps.sessions.findByTokenHash(hash);
  if (session === null || session.revokedAt !== null) return;
  await deps.sessions.revoke(session.id, isoFromEpochMs(at));
}
