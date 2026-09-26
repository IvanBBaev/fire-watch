/**
 * The events a new zone's seed plan is computed over (ADR-004 A1.8), as a port.
 *
 * A1.8 seeds "every currently alertable event intersecting the new zone". The pg adapter
 * (`pg-zone-seed-candidate-reader.ts`) answers it from the same `AlertableEvent` projection
 * the live evaluation loop reads, and `pg-zone-creation.ts` wires it by default.
 * {@link NO_SEED_CANDIDATES} remains for callers with no database (tests, replay).
 *
 * **The centre crosses this boundary in clear, and stops at the adapter.** The exact
 * spatial test needs the stored centre, so the adapter receives it — but what it sends to
 * Postgres is an index-cell range on the zone grid (integers, snapped outward), never the
 * centre or anything a midpoint could recover it from beyond the ~5 km cell the zone row
 * already stores in clear (05 §5.3.2). The exact distance runs in TypeScript. Nothing on
 * either side logs the centre.
 *
 * Runs inside the zone-creation transaction, on the same client, so "currently" means the
 * snapshot the zone row is written in.
 */

import type { Coordinate } from '../clustering/geometry.js';
import type { ZoneSeedCandidate } from '../registry/zone-seed-plan.js';

/**
 * A candidate with the database references the H7 decision log keys on. Decimal text, as
 * everywhere a `bigint` crosses a port.
 */
export interface ZoneSeedCandidateRow extends ZoneSeedCandidate {
  /** `fire_events.id`. */
  readonly fireEventId: string;
  /** `fire_events.seq` at the snapshot the seed was decided on. */
  readonly seq: string;
}

export interface ZoneSeedCandidateReader {
  /**
   * Every event whose geometry lies within `radiusM` of `centre` (the *stored* centre —
   * A1.10 measures from it), each with its distance in km. Gate-agnostic: the seed plan runs
   * every candidate through `decideAlert`, so returning a non-alertable event is harmless
   * and filtering here would be a second copy of the gate. Each event at most once.
   */
  candidatesWithin(centre: Coordinate, radiusM: number): Promise<readonly ZoneSeedCandidateRow[]>;
}

/** The reader for a deployment with no alertable-event read model yet. Seeds nothing. */
export const NO_SEED_CANDIDATES: ZoneSeedCandidateReader = Object.freeze({
  candidatesWithin: () => Promise.resolve([]),
});
