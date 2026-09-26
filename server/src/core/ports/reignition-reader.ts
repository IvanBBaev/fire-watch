/**
 * Reading past events back so a new cluster can be tested for reignition (ADR-002 D2
 * "Reignition vs continuation", Appendix A rules 2 and 5).
 *
 * This is the one thing the identity engine cannot answer from its own state. The working
 * set is a trailing 72 h window, the fuel-specific reignition windows run to 21 days, and
 * the parent of a reignition is by definition an event that went undetected long enough to
 * fall out of that window. So the candidates come from `fire_events` — the registry, which
 * mirrors the working set 1:1 and keeps every event after it is archived.
 *
 * Not "`loadWorkingSet` with a wider bound": rebuilding three weeks of working set would
 * re-run the engine to answer a question about its output, and the candidate set is a
 * handful of rows per new fire under a plain spatial query in the registry's own vocabulary
 * — stored centroid, stored last detection, live rows only.
 *
 * The window overlaps the working set on purpose. T_LINK is 48 h and the active window is
 * 72 h, so an event whose last detection was 60 h ago is still in the working set and is
 * still a legitimate reignition parent — the engine declined to attach to it, which is
 * exactly the condition this port exists to follow up on. A reader that excluded the
 * working set would miss the whole 48–72 h band.
 */

import type { FuelBand } from '../clustering/clustering-params.js';
import type { Coordinate } from '../clustering/geometry.js';
import type { ReignitionCandidate } from '../clustering/reignition-window.js';
import type { EpochMs } from './clock.js';

/**
 * A past event, as the reignition test needs it.
 *
 * {@link ReignitionCandidate} carries what the tie-break reads (centroid, `started_at`,
 * internal id); the two fields added here are what the *eligibility* filter reads, and
 * both belong to the old fire rather than the new one: the gap is measured from when the
 * parent was last seen, and the window is keyed by what the parent was burning.
 */
export interface ReignitionCandidateEvent extends ReignitionCandidate {
  readonly lastDetectionAt: EpochMs;
  /**
   * The majority land cover under the parent's hull, or `null` when it is unknown,
   * `unclassified`, or no class holds a ≥ 50 % majority. All three take the middle band
   * (Appendix A rule 5), which is why one nullable field covers them rather than three
   * states a caller would have to collapse.
   *
   * Every reader returns `null` today: `fire_events` has no land-cover column and the
   * classifier is not built. That is not a stub — rule 5 *is* the answer for an
   * unclassified fire, so the 14 d band applies for a documented reason rather than
   * because a value was missing.
   */
  readonly fuelBand: FuelBand | null;
}

/**
 * The rows one new cluster wants: live events whose centroid is within `radiusKm` of `at`
 * and whose last detection falls in `[notBefore, notAfter]`.
 *
 * Both time bounds are inclusive and both are deliberately wider than the rule. The reader
 * cannot apply the real window — it is keyed by each candidate's fuel band, which arrives
 * with the candidate — so it is asked for the widest band and the per-candidate filter
 * stays in the core. A reader that returns a wider set is correct but slower; one that
 * returns a narrower set silently drops reignition links, which is invisible.
 */
export interface ReignitionQuery {
  readonly at: Coordinate;
  readonly radiusKm: number;
  readonly notBefore: EpochMs;
  readonly notAfter: EpochMs;
}

export interface ReignitionReader {
  /**
   * Candidates for a whole batch, in one call — the queries are independent and a batch
   * seeds tens of clusters, so a round trip each would be the expensive part of a cycle.
   * The union is returned, deduplicated or not; the core matches candidates to seeds by
   * re-testing distance and time, so a row that answers two queries costs nothing.
   *
   * **Live rows only** (`merged_into IS NULL`). A tombstone as `related_event_id` would
   * publish a link the API redirects away from, and nothing downstream can tell a
   * tombstone from a live row without re-reading the registry it just queried.
   */
  loadCandidates(queries: readonly ReignitionQuery[]): Promise<readonly ReignitionCandidateEvent[]>;
}
