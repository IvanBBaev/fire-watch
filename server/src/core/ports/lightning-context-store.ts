/**
 * Where the F18 per-event lightning context is kept (migration 022). The worker's
 * lightning loop finds the events that still need an answer and writes one; the API
 * reads it back for the event page.
 */

import type { EpochMs } from './clock.js';

/** An event the lightning loop has not yet answered for under the current parameters. */
export interface LightningContextCandidate {
  /** `fire_events.id`, as text (bigint). */
  readonly eventId: string;
  readonly lat: number;
  readonly lon: number;
  /** `fire_events.started_at`: the first detection. */
  readonly firstDetectedAt: EpochMs;
}

export type LightningContextStatus = 'complete' | 'unavailable';

export interface LightningContextRow {
  readonly eventId: string;
  readonly status: LightningContextStatus;
  readonly windowFrom: EpochMs;
  readonly windowTo: EpochMs;
  readonly radiusKm: number;
  /** Non-null exactly when `complete`. */
  readonly flashCount: number | null;
  /** Non-null only when at least one flash was counted. */
  readonly nearestKm: number | null;
  readonly paramsVersion: string;
  readonly filterVersion: string;
  readonly computedAt: EpochMs;
}

export interface LightningContextStore {
  /**
   * Live events (not merged away) with no row under `paramsVersion`, latest first
   * detection first, at most `limit`.
   */
  pendingEvents(
    paramsVersion: string,
    limit: number,
  ): Promise<readonly LightningContextCandidate[]>;
  /** Inserts or replaces each event's row. */
  save(rows: readonly LightningContextRow[]): Promise<void>;
}

/** What the API answers for one public id. */
export type LightningContextRead =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'event';
      readonly firstDetectedAt: EpochMs;
      readonly row: LightningContextRow | null;
    };

export interface LightningContextReader {
  readLightningContext(publicId: string): Promise<LightningContextRead>;
}
