/**
 * Where the F18 per-event lightning context is kept (migrations 022, 024). The worker's
 * lightning loop finds the events that still need an answer and writes one; the archive
 * backfill CLI answers the ones the loop no longer can; the API reads it back for the
 * event page.
 */

import type { LightningContextDrift } from '../config/lightning-context.js';
import type { EpochMs } from './clock.js';

export type LightningContextStatus = 'complete' | 'unavailable';

/** What a candidate's stored row was computed for. */
export interface LightningContextPrevious {
  readonly status: LightningContextStatus;
  readonly paramsVersion: string;
  /** The first detection the row's window ended at. */
  readonly windowTo: EpochMs;
  /** The centroid the row counted around. */
  readonly lat: number;
  readonly lon: number;
}

/** An event that may need an answer, with what its stored row (if any) was computed for. */
export interface LightningContextCandidate {
  /** `fire_events.id`, as text (bigint). */
  readonly eventId: string;
  readonly lat: number;
  readonly lon: number;
  /** `fire_events.started_at`: the first detection. */
  readonly firstDetectedAt: EpochMs;
  /** `null` when the event has no row yet. */
  readonly previous: LightningContextPrevious | null;
}

export interface LightningContextRow {
  readonly eventId: string;
  readonly status: LightningContextStatus;
  readonly windowFrom: EpochMs;
  readonly windowTo: EpochMs;
  readonly radiusKm: number;
  /** The event centroid the flashes were counted around (migration 024). */
  readonly lat: number;
  readonly lon: number;
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
   * Live events (not merged away) with no row under `paramsVersion`, or whose row was
   * computed for a centroid or first detection that has since moved beyond `drift`;
   * latest first detection first, at most `limit`.
   */
  pendingEvents(
    paramsVersion: string,
    limit: number,
    drift: LightningContextDrift,
  ): Promise<readonly LightningContextCandidate[]>;
  /**
   * For the archive backfill: live events first detected before `firstDetectedBefore`
   * without a `complete` row that still holds — no row, another params version, an
   * `unavailable` row, or a row the event has moved away from (`drift`). Latest first
   * detection first, at most `limit`.
   */
  incompleteEvents(
    paramsVersion: string,
    firstDetectedBefore: EpochMs,
    limit: number,
    drift: LightningContextDrift,
  ): Promise<readonly LightningContextCandidate[]>;
  /**
   * Inserts or replaces each event's row — except that an `unavailable` row never
   * replaces a `complete` one computed under the same parameters for the same centroid
   * and first detection, so a backfilled answer outlives a loop pass that raced it.
   */
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
