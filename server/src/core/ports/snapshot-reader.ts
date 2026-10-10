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

import type { StaticSourceVerdict } from '../static-sources/static-source-policy.js';
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
  /**
   * The registry ids of the sources whose detections the event holds (Track F source
   * filter), in any order — the snapshot builder canonicalises them — the keys of the
   * stored `source_mix` with a positive count. `null` when the row records no mix at all (the column default,
   * a hand-written row): "not recorded", which the client must read as unreported rather
   * than as "no sensor saw this".
   *
   * Read from `source_mix`, not re-derived from `event_detections`: the clustering store
   * writes the mix in the same statement as `detection_count` from the event's live
   * members (a merge survivor's included), and 004's trigger lists `source_mix`, so a new
   * sensor on an event is always a `seq` bump — the ETag and the stream see it for free.
   */
  readonly sourceIds: readonly string[] | null;
  /**
   * The stored static hot-source verdict (021, TASKS F16), or `null` when the event was
   * never evaluated (or the column holds a value this build does not know). An active
   * member is only ever `annotated` or `clear` — the two invalidating verdicts take it off
   * the map — but the type is the column's. 023 put the column in 004's trigger list, so a
   * verdict flip a mask hot reload produces is a `seq` bump the ETag and the stream see.
   */
  readonly staticSourceVerdict: StaticSourceVerdict | null;
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
