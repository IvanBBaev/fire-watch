/**
 * Machine-readable refusal codes — the `code` extension member of the API's problem
 * documents (RFC 9457 §3.2; ADR-003 A1.3).
 *
 * A problem document's `title` is English prose for a human reading a response in a
 * devtools pane; it is not a contract, and a client that switched on it would break the
 * day a title was reworded. `code` is the contract: a stable snake_case identifier the
 * server emits and the web client switches on. A code is never renamed; a refusal whose
 * meaning changes gets a new code.
 *
 * **Scope.** Every problem document on the account surface — sign-in
 * (`/api/v1/auth/*`), the account itself (`/api/v1/account`, `/api/v1/account/export`),
 * watch zones (`/api/v1/zones`) and alert channels (`/api/v1/channels/*`) — carries a
 * code. So do the problem handler's two fallbacks (`request_refused`, `internal_error`),
 * on every route. The public data routes (snapshot, stream, client-config, overlays) are
 * status-driven by design (ADR-003 A1.3: "clients key off the status code, never the
 * problem body") and carry no code of their own.
 *
 * **One code per meaning, not per title.** The three rate limits share `rate_limited`
 * (the client reads `Retry-After` either way), and a confirmation link and a sign-in link
 * that have expired are both `link_expired`: which route answered already says which link
 * it was.
 *
 * The list is the union's single source: the server's refusal tables are typed against
 * it, and the web client holds a total record over it, so a code added here without a
 * decision on the web side is a compile error there.
 */

export const PROBLEM_CODES = [
  // The problem handler's fallbacks, on every route.
  'request_refused',
  'internal_error',
  // Shared by every account-surface route.
  'origin_refused',
  'invalid_body',
  'not_signed_in',
  'rate_limited',
  'invalid_email',
  // Sign-in and channel-confirmation links.
  'link_invalid',
  'link_expired',
  'link_used',
  'link_superseded',
  'link_other_browser',
  // The account.
  'account_not_found',
  // Alert channels.
  'channel_unavailable',
  'channel_removed',
  'channel_not_found',
  'webhook_not_found',
  'webhook_unauthenticated',
  // Watch zones.
  'zone_not_found',
  'zone_name_invalid',
  'zone_radius_invalid',
  'zone_sensitivity_invalid',
  'zone_centre_invalid',
  'zone_outside_area',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** The extension member's name in a problem document. */
export const PROBLEM_CODE_MEMBER = 'code';

export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === 'string' && (PROBLEM_CODES as readonly string[]).includes(value);
}
