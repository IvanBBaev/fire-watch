/**
 * The healthchecks.io leg over HTTP.
 *
 * The ping URL is a **secret** (OPERATIONS §3): anyone holding it can keep our dead-man's
 * switch quiet forever, which is a far more useful thing to steal than it first sounds. So
 * it is assembled here and nowhere else, never logged, and stripped out of every error this
 * module produces — including errors raised by `fetch`, which quote the URL they failed on.
 *
 * One secret covers every job, using the slug form:
 *
 *   https://hc-ping.com/<ping-key>/<slug>
 *
 * The slug is the {@link HeartbeatJobId} verbatim. That is deliberate: adding a job means
 * creating a check named after it in healthchecks.io, not adding a second environment
 * variable to a VM nobody wants to redeploy at 03:00.
 *
 * Nothing here throws and nothing here retries. A ping that does not arrive is already the
 * page — retrying it locally only delays a job whose real work is finished, and a monitor
 * that can fail the process it monitors is worse than no monitor.
 */

import type { HeartbeatJobId } from '@fire-watch/contracts';

import type { Heartbeat } from '../../core/ports/heartbeat.js';

/**
 * Short by design. The heartbeat runs after the work is done, so this window is pure added
 * latency on the cycle; healthchecks.io tolerates a late ping far better than the scheduler
 * tolerates a wedged one.
 */
export const HEARTBEAT_TIMEOUT_MS = 5_000;

export interface HealthchecksHeartbeatOptions {
  /** `https://hc-ping.com/<ping-key>` — a secret, with or without a trailing slash. */
  readonly pingBaseUrl: string;
  readonly timeoutMs?: number;
  /** Injected so the test never opens a socket. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Told about a ping that did not land, with the URL already redacted. Optional because a
   * silent failure here is acceptable by design; useful because a heartbeat that has been
   * quietly failing for a week is worth one line in the log when it finally matters.
   */
  readonly onError?: (job: HeartbeatJobId, reason: string) => void;
}

export function createHealthchecksHeartbeat(options: HealthchecksHeartbeatOptions): Heartbeat {
  const baseUrl = assertPingBaseUrl(options.pingBaseUrl);
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  // Everything below is written as if the URL will end up in a log, because one day it will.
  // The match is substring-exact on the full normalized base URL: a percent-encoded form,
  // or the bare ping-key path segment quoted on its own, would slip straight through. No
  // current path produces either — `fetch` quotes the URL verbatim — and nothing should
  // rely on this catching partial forms; it is a seatbelt, not a sanitizer.
  const redact = (text: string): string => text.split(baseUrl).join('<HEARTBEAT_URL>');

  return {
    async succeeded(job: HeartbeatJobId): Promise<void> {
      try {
        const response = await doFetch(`${baseUrl}/${job}`, {
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
          // The body is a free-text note healthchecks.io shows next to the ping. Ours says
          // nothing: it would be the one place an operator-facing monitor could accumulate
          // details about our data, on a third party's servers, for no operational gain.
          body: '',
        });
        // The status line is the whole answer, but an unconsumed body parks the connection
        // until GC instead of returning it to undici's keep-alive pool. Cancelling can
        // itself reject (a stream mid-teardown); the ping has already landed either way,
        // so that error is swallowed like every other one in this adapter.
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) {
          options.onError?.(job, `heartbeat rejected with HTTP ${String(response.status)}`);
        }
      } catch (error: unknown) {
        options.onError?.(job, redact(describe(error)));
      }
    },
  };
}

/**
 * An absolute https origin with a path and nothing else, because the slug is appended to
 * it: a value that is merely a host — an operator who pasted the origin and forgot the
 * ping key — would boot cleanly and then ping a check nobody created, 404ing forever. One
 * that is not https would put the secret on the wire in clear text. And a query string or
 * fragment would survive into the slug URL and corrupt it (`…?next=1/ingest-cycle`).
 */
export function assertPingBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The value itself is never quoted back — it is the secret. That holds for every
    // message below too: describe the shape, never the value.
    throw new RangeError('heartbeat ping URL must be an absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw new RangeError('heartbeat ping URL must be https');
  }
  // Trailing slashes are stripped before the check, so `https://host///` cannot pass as
  // "has a path" and then normalise down to the bare origin it really is.
  if (url.pathname.replace(/\/+$/, '') === '') {
    throw new RangeError('heartbeat ping URL must carry the ping key as its path');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new RangeError('heartbeat ping URL must not have a query string or fragment');
  }
  return raw.replace(/\/+$/, '');
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // A timeout is the common case and deserves to read as one rather than as `AbortError`.
    return error.name === 'TimeoutError' ? 'heartbeat timed out' : error.message;
  }
  return String(error);
}
