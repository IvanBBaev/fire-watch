/**
 * The re-cluster hook the D7 swap calls after attaching an SP partition (ADR-002 D7 as
 * amended by A1.4, steps 4–6; TASKS C7).
 *
 * The engine behind it is D-track work that does not exist yet. The seam exists now so
 * the swap machinery is complete and the D-track lands as an implementation of this
 * port, not as a rewrite of the promotion run. The eventual implementation:
 *
 *   * re-clusters the swapped month with the window extended by T_LINK on both edges,
 *     writing `clustering_runs` and `event_detections.clustering_run_id` — never
 *     overwriting the live assignment (A1.4 step 4);
 *   * performs the ID-preserving promotion: Jaccard ≥ 0.5 keeps the old `public_id`,
 *     matched greedily by descending Jaccard with ties broken by oldest event then
 *     lowest internal id; unmatched old events are retired with reason
 *     `superseded_by_sp` (A1.4 step 5);
 *   * emits zero alerts (invariant I4) and never revives a retired event unless the
 *     operator passed `--allow-revive` (A1.4 step 6).
 */

export interface MonthReclusterRequest {
  /** `YYYY-MM` — the month that was just swapped. */
  readonly month: string;
}

export type MonthReclusterResult =
  /** No clustering engine exists yet (pre-D-track); the swap is complete without it. */
  | { readonly status: 'skipped_no_engine' }
  | { readonly status: 'completed'; readonly clusteringRunId: string };

export interface MonthRecluster {
  reclusterMonth(request: MonthReclusterRequest): Promise<MonthReclusterResult>;
}
