/**
 * Where `GET /api/v1/events/:publicId/detections` gets its facts: the member detections of
 * one event, behind the event's permalink.
 *
 * A read port, and as dumb as the snapshot's: it resolves a `public_id` the way ADR-002 I1
 * says every public id must resolve — forever, through any merge chain, to the final
 * survivor — and hands back the stored rows. It decides nothing about what the map shows.
 *
 * Membership is **live** membership only (`clustering_runs.kind = 'live'`): an offline
 * re-clustering run is an experiment until it is promoted (ADR-002 I4), and its rows must
 * not leak into a public answer. A merge copies the loser's live rows onto the survivor
 * (`pg-clustering-store`), so the survivor's list already contains everything the
 * tombstone ever showed.
 */

import type { EpochMs } from './clock.js';

/** One member detection, as stored. Coordinates are the hashed 5-dp values. */
export interface EventDetectionRow {
  /** The 64-hex `detection_uid` (GLOSSARY §1b). */
  readonly uid: string;
  /** The registry source id, e.g. `firms:viirs:noaa21`. */
  readonly sourceId: string;
  /** Satellite acquisition instant (`acq_ts`) — observation time, never poll time. */
  readonly observedAt: EpochMs;
  readonly lon: number;
  readonly lat: number;
  readonly confidence: 'low' | 'nominal' | 'high';
  readonly scanKm: number | null;
  readonly trackKm: number | null;
  /** Fire radiative power; null when the product does not carry it. */
  readonly frpMw: number | null;
}

export type EventDetectionsRead =
  /** No event ever had this public id. */
  | { readonly kind: 'unknown' }
  /**
   * A merge tombstone (ADR-002 D3/I1). `survivorPublicId` is the **final** survivor of
   * the chain, and the two seqs are what a validator for this answer must cover: the
   * tombstone's own and the survivor's, which moves if the survivor is itself merged.
   */
  | {
      readonly kind: 'merged';
      readonly seq: number;
      readonly survivorPublicId: string;
      readonly survivorSeq: number;
    }
  /**
   * A live (or invalidated, or archived) event and its newest `limit` member detections,
   * ascending by observation time. `truncated` is true when older members were left out.
   */
  | {
      readonly kind: 'event';
      readonly seq: number;
      readonly detections: readonly EventDetectionRow[];
      readonly truncated: boolean;
    };

export interface EventDetectionsReader {
  /**
   * Throws on a database error or a timeout — the route turns that into a 503, never
   * into an empty list, which would read as "this event has no detections".
   */
  readEventDetections(publicId: string, limit: number): Promise<EventDetectionsRead>;
}
