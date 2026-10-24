/**
 * Where `GET /api/v1/history` (V2-A1 playback) gets its facts: the archived detections
 * observed inside one window, each with the live event that holds it, if any.
 *
 * A read port, as dumb as the snapshot's: it hands back stored rows, the newest first,
 * and decides nothing about what the scrubber shows (`core/history/history-frame.ts`).
 *
 * Event membership is **live** membership only (`clustering_runs.kind = 'live'`), and only
 * to an event that is neither a merge tombstone nor invalidated — the same events a
 * permalink resolves to. A merge copies the loser's live rows onto the survivor, so a
 * merged-away event's detections show under the survivor.
 */

import type { EpochMs } from './clock.js';

/** One archived detection. Coordinates are the stored 5-dp values; the core quantises. */
export interface HistoryDetectionRow {
  /** The 64-hex `detection_uid`; orders ties, never shipped. */
  readonly uid: string;
  readonly sourceId: string;
  /** Satellite acquisition instant (`acq_ts`) — observation time, never poll time. */
  readonly observedAt: EpochMs;
  readonly lon: number;
  readonly lat: number;
  readonly frpMw: number | null;
  /** The live event holding this detection, or `null` when none does. */
  readonly eventPublicId: string | null;
}

export interface HistoryReader {
  /**
   * The newest `limit` detections with `fromMs <= acq_ts < toMs`, newest first. Throws on
   * a database error or a timeout — the route turns that into a 503, never into an empty
   * window, which would read as "nothing burned".
   */
  readHistory(
    fromMs: EpochMs,
    toMs: EpochMs,
    limit: number,
  ): Promise<readonly HistoryDetectionRow[]>;
}
