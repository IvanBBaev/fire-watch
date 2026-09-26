/**
 * The live pipeline's ADR-002 D6 score: which events of a batch are rescored, over which
 * detections, and under which context.
 *
 * ## When an event is scored
 *
 * 11 §3.4: "the score is recomputed on every attach and every merge". `scoreEvent` reads
 * nothing but the event's member set and the {@link LIVE_SCORE_CONTEXT} constants, so an
 * event whose member set did not change cannot have a different score, and the events whose
 * member set did change are exactly the ones the registry plan already rewrites
 * (`RegistryWrites.aggregates`: seeds, attaches, merge survivors). Scoring those, in the
 * same transaction as their aggregates, is therefore the whole of §3.4 — no lifecycle tick
 * ever has to rescore anything, and a score is never out of step with the members it
 * describes. The day a context input is armed (FWI changes daily; a mask or land-cover
 * layer can be re-versioned) that stops being true, and a rescore on context change will be
 * needed; it is the context's arrival, not this module, that has to add it.
 *
 * A merge tombstone is not rescored: it is a redirect with no members of its own, and
 * `scoreEvent` refuses an empty list for the same reason the replay reports its bucket as
 * `null`. An absorbed seed's row keeps the column default and no params version.
 *
 * ## Why the detections are read separately
 *
 * A `ClusterMember` carries no confidence, no day/night flag and no FRP on purpose —
 * identity must not depend on them (D6) — so the scorer's rows are read back from
 * `detections` by `(acq_ts, detection_uid)`, inside the batch transaction, after the
 * clusterer has decided membership. A key the store cannot resolve is a bug and is thrown,
 * never skipped: a short member list scores the event on less evidence than it has.
 */

import { orderMembers } from '../clustering/aggregates.js';
import type { Cluster, ClusterBatchResult } from '../clustering/types.js';
import type { EventScore, ScoringDetectionKey } from '../ports/clustering-store.js';
import type { SurvivorUpdate } from '../registry/merge-plan.js';
import type { ScoringDetection } from '../scoring/features.js';
import { scoreEvent, type ScoreContext } from '../scoring/score.js';

/**
 * The score context the live pipeline can honestly supply today — the same three absences
 * as the replay's `REPLAY_SCORE_CONTEXT`, for the same reasons, so the live bucket and the
 * replayed bucket of the same member set are the same bucket.
 *
 *   - No static hot-source mask is loaded (D9 / DATASETS), so no mask hits: the §3.6 hard
 *     override cannot fire live yet. `false` rather than "unknown" is the scorer's contract.
 *   - Nothing looks EFFIS FWI up: `null` scores `x_fwi` as 0, withholding credit.
 *   - Nothing classifies land cover (D10): `null` scores `x_agri` as 0, withholding a
 *     *penalty* — an agricultural burn scores higher than it will once D10 lands. This is
 *     the over-estimate the replay already carries and S3 is blocked on.
 *
 * Constants, not config: they are statements of what is not wired, and arming any of them
 * is a code change that has to bring its data source with it.
 */
export const LIVE_SCORE_CONTEXT: ScoreContext = Object.freeze({
  staticSourceMaskHit: false,
  fwiAtLeastHigh: null,
  arableMajorityUnderHull: null,
});

/**
 * The working-set cluster behind each aggregate. `SurvivorUpdate.clusterId` is the engine
 * id, and every aggregate is built from a cluster still in `result.state` — a miss is a
 * disagreement between the plan and the clusterer, and is thrown.
 */
function clustersOf(
  result: ClusterBatchResult,
  aggregates: readonly SurvivorUpdate[],
): readonly Cluster[] {
  const byId = new Map(result.state.clusters.map((cluster) => [cluster.id, cluster]));
  return aggregates.map((update) => {
    const cluster = byId.get(update.clusterId);
    if (cluster === undefined || cluster.publicId !== update.publicId) {
      throw new Error(
        `aggregate for ${update.publicId} names cluster ${String(update.clusterId)}, which ` +
          'is not that event in the working set the batch produced',
      );
    }
    return cluster;
  });
}

/**
 * Every detection the batch's rescored events hold, deduplicated, in canonical member
 * order per event and events in aggregate order — what the store has to read back.
 */
export function scoringDetectionKeys(
  result: ClusterBatchResult,
  aggregates: readonly SurvivorUpdate[],
): readonly ScoringDetectionKey[] {
  const seen = new Set<string>();
  const keys: ScoringDetectionKey[] = [];
  for (const cluster of clustersOf(result, aggregates)) {
    for (const member of orderMembers(cluster.members)) {
      if (seen.has(member.detectionUid)) continue;
      seen.add(member.detectionUid);
      keys.push({ detectionUid: member.detectionUid, acqTsIso: member.acqTsIso });
    }
  }
  return keys;
}

/**
 * The score of every event whose aggregates this batch rewrites, from the detections the
 * store read back for {@link scoringDetectionKeys}. Members are fed to the scorer in
 * canonical order (`orderMembers`), which is the order the replay feeds them in.
 */
export function eventScores(
  result: ClusterBatchResult,
  aggregates: readonly SurvivorUpdate[],
  detections: readonly ScoringDetection[],
  context: ScoreContext = LIVE_SCORE_CONTEXT,
): readonly EventScore[] {
  const byUid = new Map(detections.map((detection) => [detection.detectionUid, detection]));
  return clustersOf(result, aggregates).map((cluster) => {
    const rows = orderMembers(cluster.members).map((member) => {
      const row = byUid.get(member.detectionUid);
      if (row === undefined) {
        throw new Error(
          `event ${cluster.publicId} holds detection ${member.detectionUid}, which the ` +
            'store did not return for scoring; the batch is rolled back rather than scored ' +
            'on less evidence than it has',
        );
      }
      return row;
    });
    const scored = scoreEvent(rows, context);
    return {
      publicId: cluster.publicId,
      score: scored.score,
      invalidated: scored.invalidated,
      paramsVersion: scored.paramsVersion,
    };
  });
}
