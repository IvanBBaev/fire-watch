/**
 * Where the V2-A4 estimated outlines are kept (migration 032). The worker's outline loop
 * finds the events whose outline is missing or out of date and writes one; the overlay
 * route reads the active set's outlines back.
 */

import type { OutlineDetection, OutlineGeometry } from '../outlines/fire-outline.js';
import type { EpochMs } from './clock.js';

/** An event whose stored outline is missing or was drawn for another state of it. */
export interface FireOutlineCandidate {
  /** `fire_events.id`, as text (bigint). */
  readonly eventId: string;
  /** The event state the new outline will be drawn for. */
  readonly detectionCount: number;
  readonly lastDetectionAt: EpochMs;
}

export interface FireOutlineRow {
  readonly eventId: string;
  readonly paramsVersion: string;
  readonly detectionCount: number;
  readonly lastDetectionAt: EpochMs;
  readonly footprints: number;
  /** Null when no detection came from a source that draws outlines; the areas are null too. */
  readonly geometry: OutlineGeometry | null;
  readonly areaHa: number | null;
  readonly areaLowHa: number | null;
  readonly areaHighHa: number | null;
  readonly edgeUncertaintyKm: number | null;
  readonly computedAt: EpochMs;
}

export interface FireOutlineStore {
  /**
   * Events on the map (the snapshot's active set) with no row under `paramsVersion`, or
   * whose row was drawn for another detection count or last detection; latest last
   * detection first, at most `limit`.
   */
  pendingEvents(paramsVersion: string, limit: number): Promise<readonly FireOutlineCandidate[]>;
  /** The event's newest `limit` live member detections. */
  members(eventId: string, limit: number): Promise<readonly OutlineDetection[]>;
  /** Inserts or replaces each event's row. */
  save(rows: readonly FireOutlineRow[]): Promise<void>;
  /** Records that a pass under `paramsVersion` completed at `at`. */
  recordPass(paramsVersion: string, at: EpochMs): Promise<void>;
}

/** One outline as the overlay serves it. */
export interface ActiveFireOutline {
  readonly publicId: string;
  readonly geometry: OutlineGeometry;
  readonly areaHa: number;
  readonly areaLowHa: number;
  readonly areaHighHa: number;
  readonly edgeUncertaintyKm: number;
  readonly footprints: number;
  readonly lastDetectionAt: EpochMs;
}

export interface ActiveFireOutlinesRead {
  /** Null before the first pass ever completed. */
  readonly pass: { readonly paramsVersion: string; readonly completedAt: EpochMs } | null;
  /**
   * Active-set events with a non-empty outline under the pass's params version, largest
   * area first, at most `limit`. `truncated` is true when more were left out.
   */
  readonly outlines: readonly ActiveFireOutline[];
  readonly truncated: boolean;
}

export interface FireOutlineReader {
  readActiveOutlines(limit: number): Promise<ActiveFireOutlinesRead>;
}
