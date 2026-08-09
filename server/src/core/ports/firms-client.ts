/**
 * The FIRMS Area API, as the core sees it.
 *
 * The core builds the *query* and never the URL, because the URL carries the MAP_KEY as
 * a path segment. A key in a path is a key in every access log, every error message and
 * every stack trace it appears in, so the one place that can assemble it is the adapter
 * that holds it — and the core cannot leak what it was never given.
 */

import type { SourceId } from '@fire-watch/contracts';

export interface FirmsAreaQuery {
  /** The §1a canonical source. Everything downstream attributes rows to this. */
  readonly source: SourceId;
  /** The registry's `queriedProduct`, e.g. `VIIRS_NOAA20_NRT`. */
  readonly product: string;
  /** `west,south,east,north` from `polling_bbox_v1`. */
  readonly area: string;
  /**
   * UTC *calendar* days, 1–5 — not a rolling window (DATA-SOURCES §A1.1 pitfall 2).
   * Always 2 on the live path, so a poll just after 00:00 UTC still sees yesterday's
   * late-evening overpass instead of leaving a nightly hole in the archive.
   */
  readonly dayRange: number;
  /** `YYYY-MM-DD` start day; omitted on the live path, set for backfill. */
  readonly startDate?: string;
}

export interface FirmsAreaResponse {
  readonly csv: string;
  /**
   * `available_at` — the instant we could first have seen these rows (ADR-002 D1). It is
   * observed by the adapter at the moment the response completes, never derived from
   * `acq_ts`: the gap between the two is the latency several golden fixtures are about.
   */
  readonly availableAt: number;
}

export interface FirmsAreaClient {
  fetchArea(query: FirmsAreaQuery): Promise<FirmsAreaResponse>;
}

/**
 * Minting a `detection_uid` needs sha256, which is a platform capability — so it reaches
 * the core as a function, like the clock does. There is still exactly one implementation
 * (GLOSSARY §1b rule 5); this is how it gets in, not a second one.
 */
export type DetectionUidFn = (parts: {
  readonly source: string;
  readonly acqTsIso: string;
  readonly lat: string;
  readonly lon: string;
}) => string;
