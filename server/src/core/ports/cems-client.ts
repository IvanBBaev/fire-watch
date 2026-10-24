/**
 * Reads the Copernicus EMS Rapid Mapping dashboard API (TASKS V2-E3; DATA-SOURCES §V2-E3):
 * one page of the wildfire activation list, or one activation's detail.
 *
 * Value-style like the other upstream clients: nothing is thrown, a failure is a value the
 * refresh job records. The status is part of the value because a 403 on a detail is an
 * answer — the activation is restricted to registered users — not a failure, and a
 * transport failure (timeout, DNS, reset) is `status: null`.
 */

import type { EpochMs } from './clock.js';

export interface CemsFetch {
  /** The response body, only for a 200. */
  readonly body: string | null;
  /** The HTTP status, or `null` when no response arrived at all. */
  readonly status: number | null;
  /** When the response arrived, by the client's clock; `null` exactly when `body` is. */
  readonly availableAt: EpochMs | null;
  /** `null` exactly when `body` is not. Public-safe: no URL, no header. */
  readonly error: string | null;
}

export interface CemsClient {
  /** One page of wildfire activations, newest first. */
  listActivations(page: { readonly offset: number; readonly limit: number }): Promise<CemsFetch>;
  activationDetail(code: string): Promise<CemsFetch>;
}
