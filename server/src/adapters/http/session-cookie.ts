/**
 * The session cookie (05 §5.4.1 C1): `HttpOnly; Secure; SameSite=Lax; Path=/`, carrying the
 * opaque session token and nothing else.
 *
 * **Why hand-rolled rather than `@fastify/cookie`.** There is exactly one cookie, whose
 * value is base64url (no characters that need quoting or escaping), and parsing and
 * setting it are a dozen lines each. A plugin would add a dependency for a signing feature
 * a server-side session does not need: the token is already unguessable, and the row is
 * the authority.
 *
 * **Why the `__Host-` prefix.** Browsers accept a `__Host-` cookie only when it is
 * `Secure`, has `Path=/` and carries no `Domain` — so a sibling subdomain (a future staff
 * plane, C3; the auth-mail subdomain, §5.5.3) can neither read it nor plant one that
 * shadows it. The name itself is a founder-reviewable choice; see the I1 report.
 *
 * **Max-Age tracks the row.** Every authenticated response re-issues the cookie with the
 * slid expiry, so the browser forgets the cookie when the server would have refused it,
 * not earlier and not much later. The row, not the cookie, is what is checked.
 */

import type { EpochMs } from '../../core/ports/clock.js';

export const SESSION_COOKIE_NAME = '__Host-fw_session';

const ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/';

/**
 * The session token from a `Cookie` header, or undefined. Duplicates take the first — the
 * order browsers send more-specific cookies in — and a value that is not a plausible token
 * is left for `AuthTokens.hash` to refuse; nothing here decodes or unquotes.
 */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = pair.slice(eq + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** `Set-Cookie` for a session that ends at `expiresAt`; Max-Age is whole seconds, never negative. */
export function sessionCookie(token: string, expiresAt: EpochMs, at: EpochMs): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - at) / 1000));
  return `${SESSION_COOKIE_NAME}=${token}; ${ATTRIBUTES}; Max-Age=${maxAge}`;
}

/** `Set-Cookie` that makes the browser drop the cookie (sign-out, or a dead session). */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; ${ATTRIBUTES}; Max-Age=0`;
}
