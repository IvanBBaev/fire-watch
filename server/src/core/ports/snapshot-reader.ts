/**
 * Where `/snapshot.json` gets its facts (ADR-003 D1 as amended by A1.4/A1.5).
 *
 * A *read* port, and a deliberately dumb one: it hands back the rows the database says
 * are the active set and the global `seq` high-water mark, and nothing here decides what
 * the set *is*. That decision is written into the rows — `display_tier`, `merged_into`,
 * `invalidated` — by lifecycle transitions that bump `seq` (A1.4 R1), which is the whole
 * reason the snapshot can carry an ETag derived from a single integer. A reader that
 * applied a wall-clock filter on top ("...and `last_detection_at` newer than 24 h") would
 * remove events without any `seq` moving and quietly break every delta consumer.
 *
 * Both values in {@link ActiveSetRead} must come from **one database snapshot**: the
 * max seq is the promise "everything up to here is in this set", and a max seq read a
 * moment after the rows could name a change the rows do not contain — a client would
 * then send that seq back as `If-None-Match`, get a 304, and never see the change.
 */

import type { LifecycleState } from '@fire-watch/contracts';

import type { EpochMs } from './clock.js';

/**
 * The `nearest_place` document as the registry stores it (migration 001): a name in each
 * of the two product languages and the settlement's coordinates — never an OSM element
 * id (ADR-002 A1.2). The reader passes it through; the snapshot builder renders it.
 */
export interface NearestPlace {
  readonly name_bg: string;
  readonly name_en: string;
  readonly lat: number;
  readonly lon: number;
}

/** One member of the active set, as stored. Timestamps are epoch ms of the stored instant. */
export interface ActiveEventRow {
  readonly publicId: string;
  /** The global seq at this event's last projected change (per-event version, D3). */
  readonly seq: number;
  readonly status: LifecycleState;
  /** The raw 0–1 score. The builder buckets it; it never leaves the server raw (D4). */
  readonly score: number;
  readonly lon: number;
  readonly lat: number;
  readonly startedAt: EpochMs;
  readonly lastDetectionAt: EpochMs;
  readonly detectionCount: number;
  readonly nearestPlace: NearestPlace | null;
}

export interface ActiveSetRead {
  /**
   * `max(seq)` over the **whole** registry, tombstones and archive included — not over
   * the rows returned. A removal moves the removed row's seq past every member's, and it
   * is that value the client compares its stored seqs against (D3 rule 1). Zero when the
   * registry is empty.
   */
  readonly maxSeq: number;
  /** Ascending by seq. Every member with `seq > afterSeq`; the whole set for `afterSeq = 0`. */
  readonly events: readonly ActiveEventRow[];
}

/** Per-source observation recency, for the snapshot's `sources` member (D2). */
export interface SourceObservationRow {
  readonly sourceId: string;
  /** The newest satellite observation instant ingested from this source; null when none. */
  readonly lastObservedAt: EpochMs | null;
}

export interface SnapshotReader {
  /**
   * The active set — `display_tier = 'map'`, not tombstoned, not invalidated — with
   * `seq > afterSeq`, plus the global max seq from the same statement.
   *
   * Throws on a database error or a timeout; the route turns that into a problem
   * document, never into an empty set, which would read as "no fires".
   */
  readActiveSet(afterSeq: number): Promise<ActiveSetRead>;

  /**
   * One row per requested source, in the order requested, whether or not the source has
   * ever delivered anything. Observation time (`acq_ts`), never poll time.
   */
  readSourceObservations(sourceIds: readonly string[]): Promise<readonly SourceObservationRow[]>;
}
