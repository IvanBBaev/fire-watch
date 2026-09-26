/**
 * Reignition linking, as a value (ADR-002 D2 "Reignition vs continuation" and Appendix A
 * rules 2, 3 and 5; ADR-004 A1.6).
 *
 * A new cluster near an event nobody has seen for days is either the same fire the
 * satellites missed or a second burn on the same ground, and at satellite resolution that
 * question is not answerable. The ADR therefore refuses to answer it. Inside T_LINK the
 * detection simply attaches and there is one event; past T_LINK but inside the fuel window
 * and 2·ε there is a **new** event that points back at the old one with a hedged relation —
 * `possible_reignition`, whose copy states both dates and adjudicates neither; past the
 * window the new fire is unrelated and nothing is written.
 *
 * The first of those three is the engine's (`clustering/engine.ts`) and happens before this
 * module runs; the third is the absence of a link. What is here is the middle one, and it
 * is deliberately the *only* place the middle case is decided — the window arithmetic, the
 * radius and the tie-break live in `clustering/reignition-window.ts` and are called from
 * here rather than re-derived, so "is this a reignition" has one answer and one caller.
 *
 * A plan rather than a set of writes, for the same reason `merge-plan.ts` is one: the
 * relation and the alert inheritance it implies (A1.6) have to land in the same transaction
 * as the events themselves. A link written without the inheritance is the reignition
 * version of the double-notification this project exists to avoid — a zone that was told
 * "no longer detected" on Tuesday gets "new fire" on Friday about the same hillside.
 *
 * **Composition order.** This runs *after* `buildMergePlan` for the same batch and takes
 * its alias table, because a cluster seeded in this batch can be absorbed later in the same
 * batch, and a relation written against the absorbed id would point at a tombstone.
 */

import type { RelationKind } from '@fire-watch/contracts';

import { clusterCentroid } from '../clustering/aggregates.js';
import {
  FUEL_BANDS,
  tLinkMs,
  type ClusteringParams,
  type FuelBand,
} from '../clustering/clustering-params.js';
import { distanceKm, quantizeKm, withinKm } from '../clustering/geometry.js';
import {
  chooseReignitionParent,
  reignitionRadiusKm,
  reignitionWindowDays,
  reignitionWindowMs,
} from '../clustering/reignition-window.js';
import type { Cluster, SeededCluster } from '../clustering/types.js';
import { epochMsFromIso } from '../ports/clock.js';
import type { ReignitionCandidateEvent, ReignitionQuery } from '../ports/reignition-reader.js';
import { resolveAlias, type AliasLinks } from './alias-registry.js';
import { foldAlertStates, type AlertStateRow } from './alert-state.js';

/** The one relation kind this module writes. `continuation` is curated, never inferred. */
export const REIGNITION_RELATION: RelationKind = 'possible_reignition';

/**
 * One `fire_events.related_event_id` + `relation_kind` pair, with the numbers that produced
 * it.
 *
 * The gap, the distance and the window are carried because this claim is shown to a person
 * — "possible reignition of …" — and the first question about a claim like that is why the
 * system made it. Recomputing them later would need the parent's state as it was at link
 * time, which is exactly the thing that has moved on by the time anyone asks.
 */
export interface ReignitionLink {
  readonly clusterId: number;
  readonly publicId: string;
  readonly relatedClusterId: number;
  readonly relatedPublicId: string;
  readonly relationKind: RelationKind;
  /** From the parent's last detection to the new cluster's first one. Always > T_LINK. */
  readonly gapMs: number;
  /** Parent centroid to the new cluster's first detection, in 1 mm quanta. Always ≤ 2·ε. */
  readonly distanceQuanta: number;
  /** The window this link passed, in days — 7, 14 or 21 under `clustering_params_v1`. */
  readonly windowDays: number;
  /** The parent's fuel band, `null` when unclassified and the middle band was applied. */
  readonly fuelBand: FuelBand | null;
}

export interface ReignitionPlan {
  /** At most one per event, ascending by the new event's cluster id. */
  readonly links: readonly ReignitionLink[];
  /**
   * The A1.6 inheritance: rows to write onto the new event, folded from its predecessors.
   *
   * Upserts only — there is deliberately no delete list. A merge *moves* alert state
   * because the loser stops existing as a destination; a reignition parent is still a live
   * event with its own history and its own row, and moving its state would leave the zone
   * with no record of the fire it was actually notified about.
   */
  readonly alertStateUpserts: readonly AlertStateRow[];
}

export interface ReignitionPlanInput {
  /** `ClusterBatchResult.seeded`, in engine order. Only new events can be reignitions. */
  readonly seeded: readonly SeededCluster[];
  /**
   * Candidates from {@link ReignitionReader}, for the whole batch. Over-wide is expected
   * and is re-filtered here; rows that match no seed cost one distance computation each.
   */
  readonly candidates: readonly ReignitionCandidateEvent[];
  /**
   * The post-batch working set (`ClusterBatchResult.state.clusters`).
   *
   * Two jobs. It resolves the new event's cluster id after alias resolution, and it
   * refreshes any candidate the batch itself touched: the reader ran before the batch, so a
   * candidate that received a detection in it has a stale `last_detection_at`, and a stale
   * gap is the one number that can turn a continuation into a spurious reignition claim.
   */
  readonly clusters: readonly Cluster[];
  /** `MergePlan.aliases` for this batch, or the pre-batch table when there were no merges. */
  readonly aliases: AliasLinks;
  /**
   * `alert_states` for the candidates and the new events, loaded in the same transaction
   * and **as they stand after the merge plan's migration** — the adapter applies that leg
   * first, so a new event that was absorbed has already inherited its parents' rows and
   * this fold composes with them rather than racing them. Rows for uninvolved events are
   * ignored rather than rejected, as in `buildMergePlan`.
   */
  readonly alertStates: readonly AlertStateRow[];
  readonly params: ClusteringParams;
}

const EMPTY_PLAN: ReignitionPlan = { links: [], alertStateUpserts: [] };

/**
 * The widest query that can still be filtered down to the real rule.
 *
 * The reader cannot apply the window itself — it is keyed by the candidate's fuel band,
 * which arrives with the candidate — so it is asked for the widest band and
 * {@link buildReignitionPlan} narrows per candidate. The near bound is T_LINK: anything
 * closer in time is an attach the engine already decided about, and if it did not attach,
 * it decided the detection was too far away in space, which no later pass may overturn.
 */
export function reignitionCandidateQuery(
  seed: SeededCluster,
  params: ClusteringParams,
): ReignitionQuery {
  const startedAt = epochMsFromIso(seed.startedAtIso);
  return {
    at: seed.coordinate,
    radiusKm: reignitionRadiusKm(seed.epsKm, params),
    notBefore: startedAt - widestWindowMs(params),
    notAfter: startedAt - tLinkMs(params),
  };
}

interface Proposal {
  readonly seedClusterId: number;
  readonly childPublicId: string;
  readonly parent: ReignitionCandidateEvent;
  readonly gapMs: number;
  readonly distanceQuanta: number;
}

/**
 * Turns a batch's seeds into the relations and the alert inheritance they imply.
 *
 * Eligibility is three inclusive-by-Appendix-A-rule-3 comparisons, and the one strict
 * comparison in the set is strict for a reason: `Δt ≤ T_LINK` is *attach*, so the boundary
 * instant belongs to the engine and reignition is its complement. A candidate inside T_LINK
 * that the engine did not attach is a different fire burning next to a live one, and the
 * ADR gives that no relation at all.
 */
export function buildReignitionPlan(input: ReignitionPlanInput): ReignitionPlan {
  if (input.seeded.length === 0) return EMPTY_PLAN;

  const byPublicId = new Map(input.clusters.map((cluster) => [cluster.publicId, cluster]));
  const candidates = liveCandidates(input, byPublicId);
  if (candidates.length === 0) return EMPTY_PLAN;

  const tLink = tLinkMs(input.params);
  const proposals: Proposal[] = [];

  for (const seed of input.seeded) {
    const startedAt = epochMsFromIso(seed.startedAtIso);
    const radiusKm = reignitionRadiusKm(seed.epsKm, input.params);
    const childPublicId = resolveAlias(input.aliases, seed.publicId).canonical;

    const eligible = candidates.filter((candidate) => {
      // The candidate *is* this event: detections bridged the two clusters somewhere in this
      // batch, so the merge already answered the question this module asks, and it answered
      // it with evidence rather than a hedge. Both ids are resolved, so this catches the
      // case where the seed was absorbed into the candidate and the case where they were
      // absorbed into a third event together.
      if (candidate.publicId === childPublicId) return false;
      const gapMs = startedAt - candidate.lastDetectionAt;
      if (gapMs <= tLink) return false;
      if (gapMs > reignitionWindowMs(candidate.fuelBand, input.params)) return false;
      const km = distanceKm(candidate.centroid, seed.coordinate, input.params.metric);
      return withinKm(km, radiusKm, input.params.metric);
    });

    const parent = chooseReignitionParent(eligible, seed.coordinate, input.params);
    if (parent === null) continue;

    proposals.push({
      seedClusterId: seed.clusterId,
      childPublicId,
      parent,
      gapMs: startedAt - parent.lastDetectionAt,
      distanceQuanta: quantizeKm(
        distanceKm(parent.centroid, seed.coordinate, input.params.metric),
        input.params.metric,
      ),
    });
  }

  return collapse(proposals, input, byPublicId);
}

/**
 * Candidates as they stand now: resolved through the alias table, refreshed from the
 * working set, and deduplicated by the id they resolve to.
 *
 * Resolution first, because a candidate the reader saw as live may have been absorbed by
 * this very batch, and the relation has to name the event that is live when it is written
 * (I1). Refreshing second, because the survivor of that merge — and any candidate the batch
 * merely attached a detection to — has a newer last detection than the read returned.
 */
function liveCandidates(
  input: ReignitionPlanInput,
  byPublicId: ReadonlyMap<string, Cluster>,
): readonly ReignitionCandidateEvent[] {
  const resolved = new Map<string, ReignitionCandidateEvent>();

  for (const candidate of input.candidates) {
    const publicId = resolveAlias(input.aliases, candidate.publicId).canonical;
    if (resolved.has(publicId)) continue;

    const cluster = byPublicId.get(publicId);
    resolved.set(
      publicId,
      cluster === undefined
        ? { ...candidate, publicId }
        : {
            ...candidate,
            publicId,
            clusterId: cluster.id,
            centroid: clusterCentroid(cluster),
            startedAt: cluster.startedAt,
            lastDetectionAt: cluster.lastDetectionAt,
          },
    );
  }

  return [...resolved.values()];
}

/**
 * One link per event, but inheritance from every predecessor.
 *
 * Two seeds absorbed into one survivor in the same batch each carry their own proposal onto
 * the same event, and the two obligations part company there. The relation is a sentence
 * shown to a person and Appendix A rule 2 allows exactly one, so the earlier seed's wins —
 * the lowest cluster id, the same last word every other tie-break in the engine uses. The
 * inheritance is a promise not to shout twice, so it folds *all* the parents: dropping one
 * would let a zone that was notified about it receive `new_fire` about the survivor.
 */
function collapse(
  proposals: readonly Proposal[],
  input: ReignitionPlanInput,
  byPublicId: ReadonlyMap<string, Cluster>,
): ReignitionPlan {
  const byChild = new Map<string, Proposal[]>();
  for (const proposal of proposals) {
    const held = byChild.get(proposal.childPublicId);
    if (held === undefined) {
      byChild.set(proposal.childPublicId, [proposal]);
    } else {
      held.push(proposal);
    }
  }
  if (byChild.size === 0) return EMPTY_PLAN;

  const links: ReignitionLink[] = [];
  const alertStateUpserts: AlertStateRow[] = [];

  for (const [childPublicId, group] of byChild) {
    const cluster = byPublicId.get(childPublicId);
    if (cluster === undefined) {
      // The working set is where a live event lives. A new event missing from it means the
      // seeds, the aliases and the state passed here came from different batches, and the
      // relation would be written against an id this batch never produced.
      throw new RangeError(`reignition child ${childPublicId} is not in the working set`);
    }

    const chosen = group.reduce((best, proposal) =>
      proposal.seedClusterId < best.seedClusterId ? proposal : best,
    );
    links.push({
      clusterId: cluster.id,
      publicId: childPublicId,
      relatedClusterId: chosen.parent.clusterId,
      relatedPublicId: chosen.parent.publicId,
      relationKind: REIGNITION_RELATION,
      gapMs: chosen.gapMs,
      distanceQuanta: chosen.distanceQuanta,
      windowDays: reignitionWindowDays(chosen.parent.fuelBand, input.params),
      fuelBand: chosen.parent.fuelBand,
    });

    const parents = [...new Set(group.map((proposal) => proposal.parent.publicId))].sort();
    const family = new Set([childPublicId, ...parents]);
    const rows = input.alertStates.filter((row) => family.has(row.eventPublicId));
    alertStateUpserts.push(...foldAlertStates(rows, childPublicId, parents));
  }

  links.sort((a, b) => a.clusterId - b.clusterId);
  return { links, alertStateUpserts: reorder(links, alertStateUpserts) };
}

/** Upserts grouped by event in link order, zones ascending inside each — as the fold left them. */
function reorder(
  links: readonly ReignitionLink[],
  upserts: readonly AlertStateRow[],
): readonly AlertStateRow[] {
  const rank = new Map(links.map((link, index) => [link.publicId, index]));
  return [...upserts].sort((a, b) => {
    const byEvent = (rank.get(a.eventPublicId) ?? 0) - (rank.get(b.eventPublicId) ?? 0);
    return byEvent !== 0 ? byEvent : a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0;
  });
}

function widestWindowMs(params: ClusteringParams): number {
  return Math.max(...FUEL_BANDS.map((band) => reignitionWindowMs(band, params)));
}
