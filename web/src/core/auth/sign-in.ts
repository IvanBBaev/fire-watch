/**
 * First-party sign-in, web side (TASKS I1; review 05 §5.4.1 C1–C2): the magic link's
 * token, the three auth routes the server exposes, and its "am I signed in?" check.
 *
 * **The token lives in the fragment and leaves it at once.** The mailer builds
 * `<landing URL>#token=<token>`, so the token never reaches a server log, a proxy or a
 * `Referer` on the way in. {@link takeSignInToken} is the only reader: it is synchronous,
 * it runs first thing in `boot()` — before the first `await`, the first request and the
 * first render — and it rewrites the URL with `history.replaceState` so the token is not
 * in the address bar, the history entry, a bookmark or a screenshot a moment later.
 *
 * **The token is sent to exactly one place:** the body of `POST /api/v1/auth/continue`,
 * and only when the reader presses Continue. C2 forbids exchanging it on page load: mail
 * scanners prefetch links, and one that ran our script would sign itself in and burn the
 * reader's link. Nothing here logs, and no error message carries the token or an address.
 *
 * **The session is a cookie, not a bearer token.** The server answers `continue` with an
 * HttpOnly `__Host-` cookie, so every call here is same-origin with
 * `credentials: 'same-origin'` and the script never sees a credential.
 *
 * **Referrer policy is `strict-origin`, on purpose not `no-referrer`.** Under
 * `no-referrer` the Fetch standard serialises a same-origin request's `Origin` as `null`,
 * and the auth routes refuse a `null` Origin (C1's CSRF check) — the call would fail
 * closed for every reader. `strict-origin` still sends no path, so no URL of ours travels
 * in a `Referer`.
 *
 * **Refusals are told apart by the problem document's `code`**, never its `title`: the
 * title is English prose that may be reworded, the code is the contract
 * (`@fire-watch/contracts` `PROBLEM_CODES`; `server/src/adapters/http/auth-route.ts`
 * `AUTH_REFUSALS`). {@link SIGN_IN_READING_BY_CODE} is total over that union, so a code
 * added on the server side does not compile here until this client has decided what it
 * means. A body with no code, or one this build does not know (a newer server), reads by
 * status alone: a 400 from `continue` as "invalid", the conservative answer that still
 * offers a new link, and anything else as a plain failure. There is no title fallback:
 * these routes are served only by this repository's server, which has emitted codes
 * since before sign-in was first enabled anywhere.
 *
 * Framework-free and I/O-free but for the injected `fetch` (ADR-005 D1).
 */

import { isProblemCode, PROBLEM_CODE_MEMBER, type ProblemCode } from '@fire-watch/contracts';

/** Where the reader lands to finish signing in; a token found anywhere is moved here. */
export const SIGN_IN_CONTINUE_PATH = '/sign-in/continue';
/** Where a new link is requested. */
export const SIGN_IN_PATH = '/sign-in';

/** The server's auth routes (`server/src/adapters/http/auth-route.ts`). */
export const AUTH_LINK_URL = '/api/v1/auth/link';
export const AUTH_CONTINUE_URL = '/api/v1/auth/continue';
export const AUTH_LOGOUT_URL = '/api/v1/auth/logout';
/** "Am I signed in?" (`server/src/adapters/http/account-route.ts`): 200 or 401, no identity. */
export const AUTH_ACCOUNT_URL = '/api/v1/account';

/** The fragment member the mailer writes (`ses-auth-mailer.ts`: `#token=`). */
const TOKEN_MEMBER = 'token=';

/**
 * What a token can look like: base64url, and no longer than the server accepts
 * (`MAX_TOKEN_INPUT`). Anything else is never sent — it cannot be a link we issued.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** The parts of `window.location` the reader needs. */
export interface LocationLike {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

/** The part of `window.history` the reader needs. */
export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

/**
 * What the fragment held: nothing, a well-formed token, or a `token=` member that cannot
 * be one of ours (still stripped, never sent).
 */
export type TakenToken =
  | { readonly kind: 'none' }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'malformed' };

/**
 * Read the sign-in token out of the URL fragment and remove it from the URL, in one
 * synchronous step. When there is no `token=` member, the URL is left exactly as it is.
 *
 * The rewritten URL keeps the query and every other fragment member, and moves the
 * reader to {@link SIGN_IN_CONTINUE_PATH} whatever path the link pointed at, so the
 * landing path configured on the server cannot strand a token on a page that ignores it.
 */
export function takeSignInToken(location: LocationLike, history: HistoryLike): TakenToken {
  const fragment = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (fragment === '') return { kind: 'none' };
  const members = fragment.split('&');
  const tokenMembers = members.filter((member) => member.startsWith(TOKEN_MEMBER));
  if (tokenMembers.length === 0) return { kind: 'none' };

  const rest = members.filter((member) => !member.startsWith(TOKEN_MEMBER) && member !== '');
  const url =
    SIGN_IN_CONTINUE_PATH + location.search + (rest.length > 0 ? `#${rest.join('&')}` : '');
  history.replaceState(null, '', url);

  // Exactly one member, exactly the shape we issue. Two tokens is not a link we sent.
  const [only] = tokenMembers;
  if (tokenMembers.length !== 1 || only === undefined) return { kind: 'malformed' };
  const raw = only.slice(TOKEN_MEMBER.length);
  return TOKEN_SHAPE.test(raw) ? { kind: 'token', token: raw } : { kind: 'malformed' };
}

/* -------------------------------------------------------------------------- */
/* The auth client                                                             */
/* -------------------------------------------------------------------------- */

/** Whether this deployment serves sign-in at all (`FIRE_WATCH_AUTH_ENABLED`). */
export type AuthAvailability = 'available' | 'unavailable';

/**
 * What `GET /api/v1/account` said about this browser: signed in, signed out, sign-in not
 * served here (404), or no answer to go on (a 5xx, no network) — `unknown`, which every
 * surface treats like `unavailable` for showing controls, but which is never cached.
 */
export type SessionState = 'signed-in' | 'signed-out' | 'unavailable' | 'unknown';

export type RequestLinkOutcome =
  /** Sent, or not — the server answers the same either way, and so does the page. */
  | { readonly kind: 'sent' }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'invalid-email' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

/** Why a link was refused, in the page's terms. */
export type LinkRefusal = 'expired' | 'used' | 'invalid' | 'superseded' | 'other-browser';

export type ContinueOutcome =
  | { readonly kind: 'signed-in'; readonly accountCreated: boolean }
  | { readonly kind: 'refused'; readonly reason: LinkRefusal }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

export type SignOutOutcome =
  { readonly kind: 'signed-out' } | { readonly kind: 'unavailable' } | { readonly kind: 'failed' };

export interface AuthClient {
  /**
   * Whether this browser is signed in, asked afresh each call — except that "sign-in is
   * not served here" (a 404) is final for the page's life and is not asked again. Lazy:
   * nothing calls it at boot, only a surface that would show an account control.
   */
  session(): Promise<SessionState>;
  requestLink(email: string): Promise<RequestLinkOutcome>;
  /** The only call the token is ever given to. */
  continueSignIn(token: string): Promise<ContinueOutcome>;
  signOut(): Promise<SignOutOutcome>;
}

export interface AuthClientDeps {
  readonly fetchFn: typeof fetch;
}

/**
 * What a problem `code` tells the sign-in pages: a link refusal they explain, an address
 * the reader should correct, or nothing beyond what the status already says (`status`).
 */
export type SignInReading = LinkRefusal | 'invalid-email' | 'status';

/**
 * Every code the server can emit, read for the sign-in pages. Total on purpose — see the
 * module note. Codes from routes these pages never call (zones, channels, the export) are
 * `status`: should one ever arrive here, the status decides, exactly as for no code at all.
 * Exported for the exhaustiveness test.
 */
export const SIGN_IN_READING_BY_CODE: Readonly<Record<ProblemCode, SignInReading>> = {
  // Sign-in link refusals from `continue`.
  link_invalid: 'invalid',
  link_expired: 'expired',
  link_used: 'used',
  link_superseded: 'superseded',
  link_other_browser: 'other-browser',
  // From `link`.
  invalid_email: 'invalid-email',
  // Read by status: a 429 is rate limiting, a 401 is signed out, a 403/5xx is a failure.
  request_refused: 'status',
  internal_error: 'status',
  origin_refused: 'status',
  invalid_body: 'status',
  not_signed_in: 'status',
  rate_limited: 'status',
  account_not_found: 'status',
  channel_unavailable: 'status',
  channel_removed: 'status',
  channel_not_found: 'status',
  webhook_not_found: 'status',
  webhook_unauthenticated: 'status',
  zone_not_found: 'status',
  zone_name_invalid: 'status',
  zone_radius_invalid: 'status',
  zone_sensitivity_invalid: 'status',
  zone_centre_invalid: 'status',
  zone_outside_area: 'status',
};

const LINK_REFUSALS: ReadonlySet<SignInReading> = new Set<LinkRefusal>([
  'expired',
  'used',
  'invalid',
  'superseded',
  'other-browser',
]);

function isLinkRefusal(reading: SignInReading): reading is LinkRefusal {
  return LINK_REFUSALS.has(reading);
}

/**
 * The shared request shape: same-origin, the session cookie included, nothing cached,
 * and a referrer policy that sends no path (see the module note on why not `no-referrer`).
 */
function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'strict-origin',
    headers: {
      'content-type': 'application/json',
      accept: 'application/problem+json, application/json',
    },
    body: JSON.stringify(body),
  };
}

/** The session check: a plain same-origin GET (no Origin check applies to it server-side). */
function get(): RequestInit {
  return {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'strict-origin',
    headers: { accept: 'application/json, application/problem+json' },
  };
}

/**
 * The route is not there: auth is switched off server-side (404), or an origin that
 * serves only static files answered (405). Either way, sign-in does not exist here.
 */
function isAbsent(status: number): boolean {
  return status === 404 || status === 405;
}

/** The problem document's `code`, read as the sign-in pages read it; `status` when absent. */
async function readingOf(response: Response): Promise<SignInReading> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) return 'status';
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return 'status';
    const code = (body as Record<string, unknown>)[PROBLEM_CODE_MEMBER];
    return isProblemCode(code) ? SIGN_IN_READING_BY_CODE[code] : 'status';
  } catch {
    return 'status';
  }
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/**
 * Map a `continue` answer to what the page shows. Exported for tests: the mapping is the
 * part that can drift from the server's `AUTH_REFUSALS` table.
 */
export async function continueOutcomeOf(response: Response): Promise<ContinueOutcome> {
  if (response.ok) {
    try {
      const body: unknown = await response.json();
      const created =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['account_created']
          : undefined;
      return { kind: 'signed-in', accountCreated: created === true };
    } catch {
      // The cookie is set by the status, not the body; a body we cannot read is still in.
      return { kind: 'signed-in', accountCreated: false };
    }
  }
  if (isAbsent(response.status)) return { kind: 'unavailable' };
  if (response.status === 400) {
    const reading = await readingOf(response);
    return { kind: 'refused', reason: isLinkRefusal(reading) ? reading : 'invalid' };
  }
  return { kind: 'failed' };
}

export async function requestLinkOutcomeOf(response: Response): Promise<RequestLinkOutcome> {
  if (response.status === 202 || response.ok) return { kind: 'sent' };
  if (isAbsent(response.status)) return { kind: 'unavailable' };
  if (response.status === 429)
    return { kind: 'rate-limited', retryAfterSeconds: retryAfter(response) };
  if (response.status === 400 && (await readingOf(response)) === 'invalid-email') {
    return { kind: 'invalid-email' };
  }
  return { kind: 'failed' };
}

/** Map a `GET /api/v1/account` answer. Exported for tests, like the two mappers above. */
export function sessionStateOf(response: Response): SessionState {
  if (response.status === 200) {
    // A static host's SPA fallback answers any GET with `index.html` and a 200: that is a
    // site without sign-in, not a signed-in reader.
    return (response.headers.get('content-type') ?? '').includes('json')
      ? 'signed-in'
      : 'unavailable';
  }
  if (response.status === 401) return 'signed-out';
  if (isAbsent(response.status)) return 'unavailable';
  return 'unknown';
}

/** What a session state means for showing sign-in controls at all. */
export function availabilityOf(state: SessionState): AuthAvailability {
  return state === 'signed-in' || state === 'signed-out' ? 'available' : 'unavailable';
}

export function createAuthClient({ fetchFn }: AuthClientDeps): AuthClient {
  /** Set once a 404/405 said sign-in is not served here; never cleared in a page's life. */
  let absent = false;

  return {
    async session() {
      if (absent) return 'unavailable';
      try {
        const state = sessionStateOf(await fetchFn(AUTH_ACCOUNT_URL, get()));
        if (state === 'unavailable') absent = true;
        return state;
      } catch {
        return 'unknown';
      }
    },

    async requestLink(email) {
      try {
        return await requestLinkOutcomeOf(await fetchFn(AUTH_LINK_URL, post({ email })));
      } catch {
        return { kind: 'failed' };
      }
    },

    async continueSignIn(token) {
      try {
        return await continueOutcomeOf(await fetchFn(AUTH_CONTINUE_URL, post({ token })));
      } catch {
        return { kind: 'failed' };
      }
    },

    async signOut() {
      try {
        const response = await fetchFn(AUTH_LOGOUT_URL, post({}));
        if (response.ok) return { kind: 'signed-out' };
        return isAbsent(response.status) ? { kind: 'unavailable' } : { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },
  };
}
