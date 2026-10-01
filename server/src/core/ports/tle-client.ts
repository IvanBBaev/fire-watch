/**
 * Fetches one satellite's current orbital elements (TASKS F15; DATA-SOURCES §F15).
 *
 * Value-style like the other upstream clients: nothing is thrown, a failure is a value the
 * refresh job records. The HTTP status is part of the value because CelesTrak's usage
 * policy turns on it — a machine client must stop on any non-200 until a human has looked
 * (`tle-refresh.ts`) — and a transport failure (timeout, DNS, reset) must be told apart
 * from an answer, which is why `status` is `null` for the former.
 */

import type { EpochMs } from './clock.js';

export interface TleFetch {
  /** The response body, only for a 200. */
  readonly body: string | null;
  /** The HTTP status, or `null` when no response arrived at all. */
  readonly status: number | null;
  /** When the response arrived, by the client's clock; `null` exactly when `body` is. */
  readonly availableAt: EpochMs | null;
  /** `null` exactly when `body` is not. Public-safe: no URL, no header. */
  readonly error: string | null;
}

export interface TleClient {
  fetchElements(noradId: number): Promise<TleFetch>;
}
