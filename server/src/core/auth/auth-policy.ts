/**
 * The first-party sign-in policy, as pure functions (TASKS I1; 05 §5.4.1 C1–C2).
 *
 * Everything here is a rule 05 states, turned into a function of its inputs, so the rules
 * can be tested without a database, a mailer, a clock or a browser:
 *
 *   * **Magic links** (C2): single-use, a 15-minute TTL, invalidated by a newer issuance to
 *     the same address, at most three issued per address per hour, and honoured only by the
 *     UA family that asked for them. The link names a server-side pending-auth record — it
 *     is not a signed, self-contained token — so every one of those rules is a column the
 *     server checks, not a claim the link makes about itself.
 *   * **Sessions** (C1): a server-side row per browser, with a 30-day *sliding* expiry;
 *     revocation is a column, so "log out everywhere" and takeover response are one UPDATE.
 *   * **CSRF** (§5.4.1): SameSite=Lax on the cookie, plus an exact Origin match on every
 *     state-changing route — {@link isAllowedOrigin}.
 *
 * What is *not* here, because 05 leaves the mechanism open (see the I1 report): OAuth
 * (Google, Apple), the staff plane (C3 — separate subdomain, 2FA, roles) and the incident
 * draft→publish audit log (C4).
 */

import type { EpochMs } from '../ports/clock.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 05 §5.4.1 and C2, as numbers. Nothing here is a tuning knob: each is a stated rule. */
export const AUTH_POLICY = {
  /** "15-min expiry" (C2). */
  linkTtlMs: 15 * MINUTE_MS,
  /** "3/address/hour" (C2). */
  linkIssuesPerWindow: 3,
  linkIssueWindowMs: HOUR_MS,
  /** "30-day sliding expiry" (§5.4.1). */
  sessionSlidingMs: 30 * DAY_MS,
} as const;

/** RFC 5321's path limit; a longer address cannot be delivered to, so it is not accepted. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Normalizes an address the way migration 007's CHECK stores it — trimmed and lower-cased —
 * and returns null for anything that is not plausibly deliverable.
 *
 * Deliberately no more than that. Lower-casing the local part is already a (universal in
 * practice) liberty with RFC 5321; stripping `+tags` or Gmail dots would merge addresses
 * that are different mailboxes elsewhere, and is a founder decision, not a default.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return null;
  // One `@`, something on each side, a dot in the domain, and no whitespace or control
  // characters anywhere — the last because the address becomes a mail header.
  if (!/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(email)) return null;
  return email;
}

/**
 * The coarse "UA family" a magic link is bound to (C2): browser family plus a mobile flag,
 * never a version or an OS build, so that a browser updating itself between the request
 * and the click does not lock its owner out.
 *
 * The granularity is a founder decision (see the I1 report). This one is the ua-parser
 * notion of "family" ("Chrome" vs "Chrome Mobile"). Its known cost: a mail app that opens
 * links in its own in-app browser is a different family from the browser that asked, and
 * the link will say so instead of signing in.
 *
 * Order matters: Edge, Opera and Samsung Internet all also say `Chrome/`, and every
 * Chromium and WebKit browser also says `Safari/`.
 */
export function uaFamily(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /\bEdg(e|A|iOS)?\//.test(ua)
    ? 'edge'
    : /\b(OPR|Opera|OPT)\//.test(ua)
      ? 'opera'
      : /\bSamsungBrowser\//.test(ua)
        ? 'samsung'
        : /\b(Firefox|FxiOS)\//.test(ua)
          ? 'firefox'
          : /\b(Chrome|CriOS|Chromium)\//.test(ua)
            ? 'chrome'
            : /\bVersion\/[\d.]+.*\bSafari\//.test(ua)
              ? 'safari'
              : 'other';
  const mobile = /\b(Mobile|Android|iPhone|iPad|iPod)\b/.test(ua);
  return mobile ? `${browser}-mobile` : browser;
}

/**
 * The same-origin check on state-changing routes (§5.4.1). An exact match against the
 * configured origins, and a request with no `Origin` at all is refused: every browser this
 * product supports sends one on a cross-origin *and* a same-origin POST, so its absence
 * means a non-browser client — which has no business holding a session cookie.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin === '' || origin === 'null') return false;
  return allowedOrigins.includes(origin);
}

// ── Magic links ──────────────────────────────────────────────────────────────────────

export type LinkIssueDecision =
  | { readonly allowed: true; readonly expiresAt: EpochMs }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * C2's issuance limit. `recentIssuedAt` is every issuance to this address inside the last
 * window (the store's query bounds it); the fourth inside an hour is refused, and told when
 * the oldest of the three leaves the window.
 */
export function decideLinkIssue(
  recentIssuedAt: readonly EpochMs[],
  at: EpochMs,
): LinkIssueDecision {
  const windowStart = at - AUTH_POLICY.linkIssueWindowMs;
  const inWindow = recentIssuedAt.filter((issued) => issued > windowStart && issued <= at);
  if (inWindow.length < AUTH_POLICY.linkIssuesPerWindow) {
    return { allowed: true, expiresAt: at + AUTH_POLICY.linkTtlMs };
  }
  const oldest = Math.min(...inWindow);
  const freeAt = oldest + AUTH_POLICY.linkIssueWindowMs;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((freeAt - at) / 1000)) };
}

/** The pending-auth record, as the policy needs to see it. */
export interface PendingLink {
  readonly uaFamily: string;
  readonly expiresAt: EpochMs;
  readonly consumedAt: EpochMs | null;
  readonly supersededAt: EpochMs | null;
}

export type LinkRefusal = 'unknown' | 'expired' | 'used' | 'superseded' | 'other_browser';

/**
 * Whether a "Continue" click may consume the link. Checked in this order so the reason is
 * the one a user can act on: a used link is "used" even after it has also expired.
 */
export function evaluateLink(
  link: PendingLink | null,
  clickUaFamily: string,
  at: EpochMs,
): LinkRefusal | null {
  if (link === null) return 'unknown';
  if (link.consumedAt !== null) return 'used';
  if (link.supersededAt !== null) return 'superseded';
  if (at >= link.expiresAt) return 'expired';
  if (link.uaFamily !== clickUaFamily) return 'other_browser';
  return null;
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────

export interface SessionState {
  readonly expiresAt: EpochMs;
  readonly revokedAt: EpochMs | null;
}

export function isSessionLive(session: SessionState, at: EpochMs): boolean {
  return session.revokedAt === null && at < session.expiresAt;
}

/** The sliding expiry: every authenticated request moves it to thirty days from now. */
export function slidingExpiry(at: EpochMs): EpochMs {
  return at + AUTH_POLICY.sessionSlidingMs;
}
