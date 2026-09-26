/**
 * The EFFIS mapserver as the refresh cycle sees it (TASKS C4, ADR-001 A1.2).
 *
 * Value-style like the granule source: a failed fetch is a value, not an exception,
 * because "EFFIS did not answer" is a normal Tuesday for the cycle — it keeps the stale
 * copy and records the attempt. The adapter never throws for anything the network did.
 *
 * The port hands back the raw body *and* the Content-Type untouched: the A2.2 content
 * sanity verdict is core logic (it decides what gets cached), so the adapter must not
 * pre-judge the response — a 200 carrying a ServiceException XML arrives here exactly as
 * EFFIS sent it, and the cycle is what refuses it.
 */

import type { EpochMs } from './clock.js';

export interface EffisLayerRequest {
  /** The WMS/WFS layer name, for error messages and logs. */
  readonly layer: string;
  /** The full query string as ordered key/value pairs; the adapter only serializes it. */
  readonly query: Readonly<Record<string, string>>;
}

export interface EffisLayerFetch {
  /**
   * The HTTP status, or `null` when no response arrived at all. Carried even for a body
   * the adapter hands over, because the G4 classifier refuses anything but a 200.
   */
  readonly status: number | null;
  /** The whole body, or `null` when the request failed outright. */
  readonly bytes: Uint8Array | null;
  /** The Content-Type header verbatim (parameters included), or `null` when absent. */
  readonly contentType: string | null;
  /** Stamped when the body was fully in our hands, `null` on failure. */
  readonly availableAt: EpochMs | null;
  /** `null` exactly when `bytes` is not. */
  readonly error: string | null;
}

export interface EffisClient {
  fetchLayer(request: EffisLayerRequest): Promise<EffisLayerFetch>;
}
