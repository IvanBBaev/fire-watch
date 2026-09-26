/**
 * What the three provider adapters share about talking HTTP: one bounded request, a
 * body excerpt that fits on a log line, and redaction of every secret that could appear
 * in an error — including errors raised by `fetch` itself, which quote the URL they
 * failed on, and provider bodies, which have been known to echo a bad bearer token back.
 *
 * Nothing here decides an outcome. Mapping a status to `delivered` / `transient` /
 * `permanent` is provider-specific and stays with each adapter, where the reasoning can
 * cite the provider's own documentation.
 */

export type FetchLike = typeof globalThis.fetch;

/** A completed request, as the adapters want to look at it. */
export interface ProviderResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Up to {@link BODY_EXCERPT_CHARS} of the body, whitespace collapsed, redacted. */
  readonly body: string;
  /** The full body, redacted, for adapters that parse a JSON error envelope. */
  readonly rawBody: string;
}

/** The request never produced a status line: DNS, TLS, timeout, refused connection. */
export interface ProviderNetworkFailure {
  readonly status: null;
  readonly error: string;
}

export type ProviderResult = ProviderResponse | ProviderNetworkFailure;

export interface ProviderRequestOptions {
  readonly fetch: FetchLike;
  readonly url: string;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
  readonly timeoutMs: number;
  /** Every string that must never reach a log — tokens, keys, addresses. */
  readonly redact: readonly string[];
}

export const BODY_EXCERPT_CHARS = 200;

/**
 * One request, no retry, no redirects, every failure shape collapsed into a value.
 *
 * Redirects are an error because a provider that redirects a signed or bearer-authed
 * POST is either misconfigured or being impersonated, and following it would replay
 * the credential to wherever it points.
 */
export async function providerRequest(options: ProviderRequestOptions): Promise<ProviderResult> {
  const redact = redactor(options.redact);
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    return { status: null, error: redact(describeError(error)) };
  }
  let rawBody: string;
  try {
    rawBody = redact(await response.text());
  } catch {
    rawBody = '<unreadable body>';
  }
  return { status: response.status, headers: response.headers, body: excerpt(rawBody), rawBody };
}

/** Replaces each secret with a placeholder; the empty string is skipped, not a wildcard. */
export function redactor(secrets: readonly string[]): (text: string) => string {
  const live = secrets.filter((secret) => secret.length > 0);
  return (text) => live.reduce((acc, secret) => acc.split(secret).join('<redacted>'), text);
}

export function excerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > BODY_EXCERPT_CHARS
    ? `${collapsed.slice(0, BODY_EXCERPT_CHARS)}…`
    : collapsed;
}

/**
 * `fetch` failures come as a `TypeError` whose `cause` carries the useful part (the
 * errno, the timeout), so both are surfaced; a bare `AbortError` is the timeout.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : '';
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

/**
 * `Retry-After` as milliseconds from now, or `null` when absent or unparseable. Accepts
 * the delta-seconds form and the HTTP-date form (RFC 9110 §10.2.3); a date in the past
 * is 0, not negative.
 */
export function retryAfterMs(headers: Headers, now: number): number | null {
  const value = headers.get('retry-after');
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}
