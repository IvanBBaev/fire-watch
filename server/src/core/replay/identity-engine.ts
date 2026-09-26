/**
 * The golden-replay engine that runs the *real* identity code (D5; gates CI-1, CI-2).
 *
 * `smoke-engine.ts` proves the harness is deterministic. This proves the product is: it
 * drives `clusterBatch`, `buildMergePlan` and `buildReignitionPlan` — the same three
 * functions the live poller calls — batch by batch, keeps the working set between polls,
 * and turns the result into the outcome vocabulary a fixture is allowed to assert. There is
 * no second implementation of clustering, merging or relation here, and there must never be
 * one; everything below is bookkeeping around those functions' own output.
 *
 * Four pieces of that bookkeeping are not obvious, and each exists because dropping it
 * loses an event the fixture is entitled to see:
 *
 *   - **Eviction is not deletion.** `clusterBatch` drops a cluster from the working set once
 *     it is 72 h stale, because it is no longer attach-eligible. The event still exists — it
 *     is simply finished — so an evicted cluster is copied into an archive and still
 *     reported, and still offered as a reignition parent. Without this, any fixture spanning
 *     more than three days would silently lose its earlier events and its `expected.json`
 *     would record that loss as the truth.
 *   - **A merge loser is a tombstone, not a hole.** The absorbed `public_id` keeps existing
 *     and points at the survivor (I1/I2), which is exactly what S2 asserts.
 *   - **The pinned config versions are checked, not decorative.** A fixture that pins
 *     `clustering_params_v1` and is replayed under v2 asserts nothing about either. The
 *     mismatch throws here, at load, instead of surfacing as an unexplained diff.
 *   - **The lifecycle is ticked here, once per poll.** `lifecycle-tick.ts` owns D4's rules
 *     and this file owns the clock: at the end of every batch it hands the tick the window
 *     since the previous poll and every event that exists, archived ones included. Archived
 *     events are ticked for the same reason they are reported — a display tier goes on
 *     ageing from `map` to `feed` to `archive` long after the cluster left the working set,
 *     and an event skipped by the tick would freeze at whichever tier it last held.
 *
 * `bucket` is answered here as of D12: every reported event carries the bucket
 * `scoreEvent` gives it, and the fixtures were re-authored against those answers rather
 * than against a guess — which is what the previous version of this paragraph promised
 * would happen the day the scorer landed. `labels` is still `[]`: S3's and S4's label
 * rules need the land cover and the static-source mask D10 owes, and inventing a plausible
 * constant for them would let a fixture assert an outcome that no function decides.
 *
 * Three things about the score in replay are worth stating, because each is a limit of the
 * *format* rather than of the scorer, and each one silently withholds evidence:
 *
 *   - **`x_edge` is structurally 0.** A fixture's detections carry no pixel footprint (see
 *     `toClusteringDetection` below), so every row resolves to its instrument's nadir pixel
 *     and no row is ever "at swath edge". No replay can exercise that penalty.
 *   - **`x_fwi` and `x_agri` are 0 because nothing was asked.** Both are stated inputs the
 *     format has no field for yet, and `null` means "not looked up". For `x_fwi` that
 *     withholds credit and is safe; for `x_agri` it withholds a *penalty*, so a replayed
 *     score is an over-estimate for anything over cropland. That is precisely why S3 stays
 *     blocked on D10 in `register.ts` even though the score now exists.
 *   - **`staticSourceMaskHit` is `false`, not "unknown".** No mask data exists, so no mask
 *     can hit; the override cannot fire in replay, which is why S4 stays blocked too.
 *
 * When D10 lands, these three become fixture-stated observations on the precedent cloud
 * cover already set, and S3/S4 are authored against a real answer for the first time.
 */

import { SOURCE_REGISTRY_VERSION, assertSourceId } from '@fire-watch/contracts';

import { orderMembers } from '../clustering/aggregates.js';
import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { clusterBatch, emptyState } from '../clustering/engine.js';
import type { Cluster, ClusteringConfig, ClusteringDetection } from '../clustering/types.js';
import { LIFECYCLE_PARAMS } from '../config/lifecycle-params.js';
import { PASS_TABLE, staticPassPredictor } from '../lifecycle/static-pass-predictor.js';
import {
  reignitionCandidateFor,
  tickEventFor,
  type MemberObservations,
} from '../identity/identity-batch.js';
import type { LifecycleDecision, OfficialDeclaration } from '../lifecycle/types.js';
import { NO_ALIASES, resolveAlias, type AliasLinks } from '../registry/alias-registry.js';
import { buildMergePlan } from '../registry/merge-plan.js';
import { buildReignitionPlan } from '../registry/reignition-plan.js';
import type { ScoringDetection } from '../scoring/features.js';
import { SCORE_PARAMS } from '../scoring/score-params.js';
import { scoreEvent, type ScoreContext } from '../scoring/score.js';
import type { FixtureDeclaration } from './fixture-format.js';
import { tickLifecycle, type LifecycleCarry, type TickEventInput } from './lifecycle-tick.js';
import type { ReplayContext, ReplayDetection, ReplayEngine, ReplayEvent } from './runner.js';

export interface IdentityEngineOptions {
  /** The parameter set to replay under. An argument so a v2 fixture can pin v2. */
  readonly config?: ClusteringConfig;
}

/** One event's relation, in the shape a fixture asserts it. */
interface EventRelation {
  readonly publicId: string;
  readonly kind: string;
}

/**
 * Builds the {@link ReplayEngineFactory} the CLI hands to `runReplay`. Curried rather than a
 * bare factory so the parameter set stays an argument instead of a module-level default that
 * a caller cannot see it depends on.
 */
export function identityEngine(
  options: IdentityEngineOptions = {},
): (context: ReplayContext) => ReplayEngine {
  const config = options.config ?? CLUSTERING_PARAMS;
  return (context) => createIdentityEngine(context, config);
}

export function createIdentityEngine(
  context: ReplayContext,
  config: ClusteringConfig = CLUSTERING_PARAMS,
): ReplayEngine {
  assertPinnedVersions(context.configVersions, config);
  const params = config.values;

  let state = emptyState();
  let aliases: AliasLinks = NO_ALIASES;
  /** Clusters that aged out of the working set. Finished events, not deleted ones. */
  const archived = new Map<number, Cluster>();
  /** Relations, keyed by the child event. At most one per event (Appendix A rule 2). */
  const relations = new Map<string, EventRelation>();

  const predictor = staticPassPredictor();
  /**
   * The delivered row by detection uid. `ClusteringDetection` has no room for confidence,
   * FRP or the day/night flag — clustering is a question about position and time, and
   * ADR-002 D6 is explicit that scoring must never change identity — so the row is kept
   * here on the way past for the two consumers that do read those fields: the lifecycle
   * tick (is this event large, was GEO ever bright enough to witness it) and the score. A
   * uid is unique, so a row redelivered in a later poll rewrites its own entry.
   */
  const rowByUid = new Map<string, ReplayDetection>();
  /** Curated statements, indexed by the detection whose event they speak about. */
  const declarationsByUid = indexDeclarations(context.observations.declarations);
  /** The last decision each event received. `events()` reads its status and tier from here. */
  const decisions = new Map<string, LifecycleDecision>();
  let carry: ReadonlyMap<string, LifecycleCarry> = new Map();
  /**
   * The instant the previous tick ran, and so the start of the next evidence window. It
   * begins at the fixture's `clockStart`: `runReplay` sets the virtual clock there before
   * it calls this factory, which makes the first window "since the fixture began" rather
   * than an arbitrary zero that would sweep in every overpass since the epoch.
   */
  let lastTickMs = context.clock.now();

  /**
   * FRP and curated statements per member, answered from what this engine saw go past.
   * `tickEventFor` (shared with the live pipeline) owns how an event is read by the tick.
   */
  const observed: MemberObservations = {
    frpMw: (uid) => rowByUid.get(uid)?.frpMw ?? null,
    declarations: (uid) => declarationsByUid.get(uid) ?? [],
  };
  const toTickEvent = (cluster: Cluster): TickEventInput => tickEventFor(cluster, observed);

  /**
   * The event's ADR-002 D6 bucket, from the same `scoreEvent` the product calls.
   *
   * Members are read back through `rowByUid` rather than off the cluster, because a
   * `ClusterMember` deliberately carries no confidence and no FRP: identity is a question
   * about position and time and D6 is explicit that scoring never changes it. The lookup
   * cannot miss — a member is a detection this engine ingested — and a miss is reported as
   * a bug rather than skipped, since a silently short member list would score the event on
   * less evidence than it has and quietly move the bucket down.
   */
  function bucketFor(cluster: Cluster): string {
    const detections = orderMembers(cluster.members).map((member) => {
      const row = rowByUid.get(member.detectionUid);
      if (row === undefined) {
        throw new Error(
          `cluster ${cluster.publicId} holds detection ${member.detectionUid}, which this ` +
            'engine never ingested; the row map and the clusterer disagree about membership',
        );
      }
      return toScoringDetection(row);
    });
    return scoreEvent(detections, REPLAY_SCORE_CONTEXT).bucket;
  }

  return {
    ingest(batch: readonly ReplayDetection[]): void {
      for (const detection of batch) rowByUid.set(detection.detectionUid, detection);

      const live = new Map(state.clusters.map((cluster) => [cluster.id, cluster]));
      // Everything that existed *before* this batch, which is exactly the set a seed in this
      // batch may be a reignition of. Taken now, because the batch is about to age some of
      // these out of the working set and mint new clusters that must not be their own parent.
      const candidates = [...archived.values(), ...live.values()].map(reignitionCandidateFor);

      const result = clusterBatch({
        detections: batch.map(toClusteringDetection),
        state,
        now: context.clock.now(),
        config,
      });

      for (const clusterId of result.evictedClusterIds) {
        const evicted = live.get(clusterId);
        // Defined for every evicted id — eviction is computed from this very set — but the
        // engine's contract is a list of ids, and reading it as one keeps the two in step.
        if (evicted !== undefined) archived.set(clusterId, evicted);
      }

      // The merge plan first, and the reignition plan on the table it produced: a candidate
      // this batch absorbed has to be named by the id that is live once the batch commits.
      aliases = buildMergePlan({
        merges: result.merges,
        clusters: result.state.clusters,
        aliases,
        alertStates: [],
        params,
      }).aliases;

      const reignition = buildReignitionPlan({
        seeded: result.seeded,
        candidates,
        clusters: result.state.clusters,
        aliases,
        alertStates: [],
        params,
      });
      for (const link of reignition.links) {
        relations.set(link.publicId, { publicId: link.relatedPublicId, kind: link.relationKind });
      }

      state = result.state;

      // The tick runs last, on the batch as it finally stands: an event merged away by this
      // poll must not also receive a lifecycle decision of its own, and the survivor must be
      // weighed with the detections it just absorbed.
      const atMs = context.clock.now();
      const outcome = tickLifecycle({
        atMs,
        sinceMs: lastTickMs,
        events: [...archived.values(), ...state.clusters].map(toTickEvent),
        carry,
        predictor,
        cloud: context.observations.cloudCover,
        outages: context.observations.outages,
      });
      for (const { decision } of outcome.results) decisions.set(decision.publicId, decision);
      // Replaced, never rebuilt: the carry is where accumulated E, the GEO daily balance and
      // the display-window anchor live, and dropping it resets all three without a trace.
      carry = outcome.carry;
      lastTickMs = atMs;
    },

    events(): readonly ReplayEvent[] {
      const events: ReplayEvent[] = [];

      for (const cluster of [...archived.values(), ...state.clusters]) {
        // `null` only for an event no tick has reached, which a replay that ticks every
        // batch cannot produce. Reported rather than defaulted, so a wiring mistake shows
        // up as a missing status instead of a plausible one.
        const decision = decisions.get(cluster.publicId);
        events.push({
          publicId: cluster.publicId,
          status: decision?.state ?? null,
          displayTier: decision?.displayTier ?? null,
          bucket: bucketFor(cluster),
          detectionUids: cluster.members.map((member) => member.detectionUid),
          mergedInto: null,
          relation: relations.get(cluster.publicId) ?? null,
          labels: [],
        });
      }

      // A tombstone carries no detections of its own: the merge re-attributed them to the
      // survivor, and listing them twice would make a fixture assert that one detection is
      // evidence of two events. It carries no lifecycle either — it is a pointer to the
      // survivor, and giving it a state of its own would make a fixture assert that one
      // fire is in two. The same argument retires its bucket: scoring an empty member list
      // is not "unverified", it is undefined, and `scoreEvent` refuses it outright.
      for (const tombstone of aliases.keys()) {
        events.push({
          publicId: tombstone,
          status: null,
          displayTier: null,
          bucket: null,
          detectionUids: [],
          mergedInto: resolveAlias(aliases, tombstone).canonical,
          relation: null,
          labels: [],
        });
      }

      return events;
    },
  };
}

/**
 * The score context a replay can honestly supply, and the reason each field is what it is.
 *
 * All three are absences, not values, and they are constants because the fixture format has
 * no field to state them with — the engine header says what that costs and which register
 * entries stay blocked because of it. Written out here rather than inlined so that adding
 * the fixture-stated version later is a change to one named thing.
 */
const REPLAY_SCORE_CONTEXT: ScoreContext = Object.freeze({
  // No mask data exists, so no mask hits. `false` rather than a nullable "unknown" is the
  // scorer's own contract: an override that can be skipped by passing null is not an
  // override. It means the §3.6 hard override cannot fire in replay, which is S4's blocker.
  staticSourceMaskHit: false,
  // Nothing looked EFFIS FWI up. `null` scores x7 as 0, withholding credit — the safe way
  // to be wrong.
  fwiAtLeastHigh: null,
  // Nothing classified the land cover. `null` scores x8 as 0, withholding a *penalty* —
  // the unsafe way to be wrong, and the reason S3 is still blocked on D10.
  arableMajorityUnderHull: null,
});

/**
 * A delivered row as the scorer reads it.
 *
 * `scanKm`/`trackKm` are `null` for the same reason `toClusteringDetection` sets them so:
 * the format carries no footprint. In the scorer that resolves to the instrument's nadir
 * pixel, which is never above its own multiple, so `x_edge` is 0 for every replayed event.
 * `overOrAdjacentToWater` is `null` because no land cover was consulted, and the §3.6
 * water/glint guard is written to keep a detection nobody asked a question about.
 */
function toScoringDetection(detection: ReplayDetection): ScoringDetection {
  return {
    detectionUid: detection.detectionUid,
    source: assertSourceId(detection.source),
    acqTsIso: detection.acqTsIso,
    latCanonical: detection.latCanonical,
    lonCanonical: detection.lonCanonical,
    confidence: detection.confidence,
    dayNight: detection.dayNight,
    frpMw: detection.frpMw,
    scanKm: null,
    trackKm: null,
    overOrAdjacentToWater: null,
  };
}

/**
 * A fixture's detections carry no pixel footprint: the replay format is the fields a
 * scenario asserts on, and `scan`/`track` are provider telemetry that would have to be kept
 * in sync by hand for no assertion's benefit. `null` selects the per-source default ε
 * (Appendix A rule 4) — the same path a provider row that sent no footprint takes.
 */
function toClusteringDetection(detection: ReplayDetection): ClusteringDetection {
  return {
    detectionUid: detection.detectionUid,
    source: assertSourceId(detection.source),
    availableAt: detection.availableAt,
    acqTsIso: detection.acqTsIso,
    latCanonical: detection.latCanonical,
    lonCanonical: detection.lonCanonical,
    scanKm: null,
    trackKm: null,
  };
}

/**
 * Every statement the fixture made, grouped by the detection it names.
 *
 * A list per uid rather than a single statement: an event can be declared contained and
 * later extinguished, and both are history the tick resolves a standing one from. Which of
 * two is standing is the tick's decision, not this index's.
 */
function indexDeclarations(
  declarations: readonly FixtureDeclaration[],
): ReadonlyMap<string, readonly OfficialDeclaration[]> {
  const byUid = new Map<string, OfficialDeclaration[]>();
  for (const declaration of declarations) {
    const stated: OfficialDeclaration = {
      state: declaration.state,
      declaredAtMs: declaration.declaredAtMs,
      attribution: declaration.attribution,
    };
    const existing = byUid.get(declaration.detectionUid);
    if (existing === undefined) byUid.set(declaration.detectionUid, [stated]);
    else existing.push(stated);
  }
  return byUid;
}

function assertPinnedVersions(
  pinned: Readonly<Record<string, string>>,
  config: ClusteringConfig,
): void {
  requirePin(pinned, config.name, config.version);
  // The lifecycle tick reads both of these on every poll, so a fixture that records a
  // `status` without naming them asserts nothing about it. The pass table is exactly as
  // load-bearing as ε: it is a model of the constellation, and a refit changes which
  // overpasses a fixture's miss evidence was ever measured against.
  requirePin(pinned, LIFECYCLE_PARAMS.name, LIFECYCLE_PARAMS.version);
  requirePin(pinned, PASS_TABLE.name, PASS_TABLE.version);
  // Every reported event now carries a bucket, and the bucket is a function of these
  // weights: a fixture replayed under refitted ones asserts nothing about the bucket it
  // records. Pinned for the same reason ε is, and D7 will move this version.
  requirePin(pinned, SCORE_PARAMS.name, SCORE_PARAMS.version);

  const sources = pinned['sources'];
  if (sources !== undefined && sources !== SOURCE_REGISTRY_VERSION) {
    // ε per source comes from that registry, so a fixture authored against a different one
    // asserts distances that are not the ones the engine applies.
    throw new Error(
      `fixture pins sources=${sources} but the replay runs ${SOURCE_REGISTRY_VERSION}`,
    );
  }
}

/** Exported for the alert engine, which pins one more config than this one consults. */
export function requirePin(
  pinned: Readonly<Record<string, string>>,
  name: string,
  version: string,
): void {
  const found = pinned[name];
  if (found === undefined) {
    throw new Error(
      `fixture does not pin "${name}" — a replay that names no version for a parameter ` +
        'set it consults asserts nothing about it (ADR-002 D5)',
    );
  }
  if (found !== version) {
    throw new Error(
      `fixture pins ${name}=${found} but the replay runs ${version}; ` +
        're-author the fixture under the new parameters or replay it under the pinned ones',
    );
  }
}
