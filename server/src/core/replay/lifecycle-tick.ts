/**
 * The tick that runs D4's lifecycle rules over a replay's virtual clock (TASKS D4;
 * ADR-002 D6 as amended by A2.2, A2.3 and A1.3; gates CI-1, CI-2).
 *
 * `e-accumulator.ts` answers how much evidence there is that nothing saw a fire, and
 * `lifecycle-state.ts` answers what we are therefore allowed to say. Neither of them
 * ticks: both are pure functions of one event, one instant and one window, and something
 * has to walk the clock forward, hand each event the window since the previous instant,
 * and carry the answer into the next one. Until that something exists every replayed
 * event reports `status: null` — which is exactly what `identity-engine.ts` says, and why
 * it says it.
 *
 * This file is that something and nothing more. **It re-decides nothing.** There is no
 * threshold here, no cloud gate, no diurnal condition, no display window; every one of
 * those lives in the two modules above and a second copy of any of them would eventually
 * disagree with the first about an event nobody could explain. What is left is
 * bookkeeping — and the bookkeeping has five load-bearing judgements, each of which
 * changes an outcome and so is written down where it is made.
 *
 * ## 1. The standing declaration is applied *before* the rules run
 *
 * `decideLifecycle`'s `conclude()` throws if the tick tries to put an event into an
 * `officially_*` state: only an attributed statement may set one (A2.2), and that
 * invariant is executable rather than a review comment. So the statement is applied here,
 * on the snapshot, and the state machine only ever sees a state it is allowed to keep.
 * `TickEventInput.declarations` is history rather than state — every statement ever known
 * about the event, in any order — so the standing one is recomputed each tick as the
 * greatest `declaredAtMs <= atMs`, under a total order that does not depend on the order a
 * fixture happened to list them in.
 *
 * A statement is applied to the state only on the tick it *becomes* standing. Afterwards
 * the machine owns the state and the statement stays on as history, which is A2.2 read
 * exactly: a re-detection within T_LINK "returns the event to `active`", and the event
 * "keeps the declaration, its timestamp, and its \u0413\u0414\u041f\u0411\u0417\u041d attribution, and continues to
 * display them after the return to `active`". What satellite data may never do is *set* or
 * *clear* an `officially_*` state; re-applying the same statement every tick would instead
 * make that return last exactly one tick, and S12's dual-fact copy \u2014 detections at `<t>`,
 * official declaration at `<t0>`, adjudicating neither \u2014 would have no state to sit on.
 * `officialDeclaration` is therefore carried forward on every tick; `state` is not.
 *
 * ## 2. E is reset when a detection arrives, and only here
 *
 * `accumulateMissEvidence` marks every pass at or before the last detection `detected` at
 * zero weight, but it keeps the history it was handed: `e = accumulatedE + addedE`, where
 * `accumulatedE` is whatever the caller carried in. `lifecycle-state.ts` states in its own
 * docblock that it never resets E and points at whoever owns the carry. That is this file.
 * Without the reset, a fire detected every few days keeps every miss between its
 * detections, creeps to the threshold, and closes while it is being seen — on evidence
 * that a pixel has already answered.
 *
 * ## 3. Arrival is measured in acquisition time, against what the previous tick knew
 *
 * A poll delivers rows acquired hours earlier — S1's second poll lands at 03:50Z carrying
 * a 00:12Z acquisition — so "did a detection arrive in `[sinceMs, atMs)`" cannot be asked
 * of an acquisition instant: those are two different clocks and the answer would be "no"
 * on a poll that plainly brought something. The question is therefore asked entirely in
 * acquisition time, against {@link LifecycleCarry.lastDetectionAtMs}: a detection arrived
 * when the event's newest acquisition is newer than the one the previous tick knew about.
 * No availability plumbing, and no dependence on when the fixture chose to poll.
 *
 * ## 4. `hullAreaHa` and `peatOrLandfill` are absent, not defaulted
 *
 * Nothing in this repo computes either — there is no land-cover classifier and no hull
 * geometry reaches a lifecycle tick — so the snapshot says `null` and `false` rather than
 * inventing a size, and largeness is decided from `maxFrpMw` alone. The reasoning is set out
 * where the snapshot is built.
 *
 * ## 5. The carry is a map the engine owns, and a tick never drops from it
 *
 * A tick may be handed a subset of the events the carry knows about, and an entry that
 * quietly vanished would silently reset that event's accumulated E, its GEO daily balance
 * and its display-window anchor. The outgoing map is therefore the incoming one plus this
 * tick's answers.
 *
 * Determinism, as everywhere in the core: no clock, no randomness, results in input order,
 * and every ordering decision made by a total comparator over values the caller supplied.
 */

import type { LifecycleState, SourceId } from '@fire-watch/contracts';

import { CLUSTERING_PARAMS, type ClusteringParams } from '../clustering/clustering-params.js';
import type { Coordinate } from '../clustering/geometry.js';
import { LIFECYCLE_PARAMS, type LifecycleParams } from '../config/lifecycle-params.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import { accumulateMissEvidence } from '../lifecycle/e-accumulator.js';
import { decideLifecycle } from '../lifecycle/lifecycle-state.js';
import type {
  CloudCoverSample,
  EventObservationSnapshot,
  GeoWeightSpent,
  LifecycleDecision,
  MissEvidence,
  OfficialDeclaration,
  SourceOutage,
} from '../lifecycle/types.js';
import type { EpochMs } from '../ports/clock.js';
import type { PassPredictor } from '../ports/pass-predictor.js';

/** What the replay engine knows about one event at the instant the tick runs. */
export interface TickEventInput {
  readonly publicId: string;
  readonly centroid: Coordinate;
  readonly lastDetectionAtMs: EpochMs;
  readonly lastDetectionSource: SourceId;
  readonly lastFrpMw: number | null;
  readonly maxFrpMw: number | null;
  /** Every official statement known about this event, in any order. History, not state. */
  readonly declarations: readonly OfficialDeclaration[];
}

/** The per-event state one tick hands to the next. The replay engine owns the map. */
export interface LifecycleCarry {
  readonly state: LifecycleState;
  readonly accumulatedE: number;
  readonly geoWeightSpent: GeoWeightSpent | null;
  /** Where the unobservable run is counted from; `null` on an event no tick has weighed. */
  readonly blindSinceMs: EpochMs | null;
  readonly inactiveSinceMs: EpochMs | null;
  readonly officialDeclaration: OfficialDeclaration | null;
  /**
   * The newest acquisition the previous tick knew about, or `null` on an event no tick has
   * seen. This is the whole of the redetection test (module docblock, rule 3): comparing
   * the event's current newest acquisition against this one asks "is there a detection here
   * that was not here last time" in a single clock, which is the only clock both the
   * identity engine's T_LINK and this file's E reset are expressed in.
   */
  readonly lastDetectionAtMs: EpochMs | null;
}

export interface LifecycleTickRequest {
  readonly atMs: EpochMs;
  /**
   * The previous tick's instant. The evidence window is half-open `[sinceMs, atMs)`.
   *
   * It bounds the window and nothing else — in particular it does not decide whether a
   * detection arrived, because delivery time and acquisition time are different clocks.
   */
  readonly sinceMs: EpochMs;
  readonly events: readonly TickEventInput[];
  readonly carry: ReadonlyMap<string, LifecycleCarry>;
  readonly predictor: PassPredictor;
  readonly cloud: readonly CloudCoverSample[];
  readonly outages: readonly SourceOutage[];
}

export interface LifecycleTickResult {
  readonly evidence: MissEvidence;
  readonly decision: LifecycleDecision;
}

export interface LifecycleTickOutcome {
  /** One per input event, in input order. */
  readonly results: readonly LifecycleTickResult[];
  readonly carry: ReadonlyMap<string, LifecycleCarry>;
}

/**
 * Where a `public_id` the carry has never seen starts.
 *
 * `active` because that is the state the identity engine mints an event in, and zero
 * evidence because an event nothing has weighed yet has none. `lastDetectionAtMs: null`
 * is the one that is not merely an initial value: it is what makes the first tick of a
 * brand-new event report a detection rather than compare its acquisition against a zero.
 *
 * Frozen so that a caller which reads it and then mutates it cannot give every fresh event
 * in a replay the leftovers of the last one it touched.
 */
export const FRESH_CARRY: LifecycleCarry = Object.freeze({
  state: 'active',
  accumulatedE: 0,
  geoWeightSpent: null,
  blindSinceMs: null,
  inactiveSinceMs: null,
  officialDeclaration: null,
  lastDetectionAtMs: null,
});

/**
 * Runs one lifecycle tick over every event it is handed and returns the carry for the next.
 *
 * Takes the whole {@link VersionedConfig} rather than the bare values because it passes it
 * through to both rule modules, which stamp `paramsVersion` on their answers: evidence and
 * a decision that cannot say which calibration produced them are ones a refit turns
 * retroactively into a different claim.
 */
export function tickLifecycle(
  request: LifecycleTickRequest,
  config: VersionedConfig<LifecycleParams> = LIFECYCLE_PARAMS,
  clustering: ClusteringParams = CLUSTERING_PARAMS.values,
): LifecycleTickOutcome {
  assertRequest(request);

  const { atMs, sinceMs, predictor, cloud, outages } = request;
  // Copied before anything is written, so entries for events this tick was not handed
  // survive verbatim (module docblock, rule 5).
  const carry = new Map(request.carry);
  const results: LifecycleTickResult[] = [];

  for (const event of request.events) {
    const carried = request.carry.get(event.publicId) ?? FRESH_CARRY;
    const declaration = standingDeclaration(event.declarations, atMs);
    // Applied to the state only where it is newer than the statement the carry already
    // holds. See rule 1: the second tick after a re-detection must not quietly undo it.
    const declaredNow =
      declaration !== null &&
      (carried.officialDeclaration === null ||
        declaration.declaredAtMs > carried.officialDeclaration.declaredAtMs)
        ? declaration
        : null;

    // A detection arrived when the event's newest acquisition is newer than the one the
    // previous tick knew about. Strictly newer: a row that arrives late carrying an
    // acquisition we already hold — or an older one — is evidence about a moment we had
    // already accounted for, and reading it as an arrival would void miss evidence that
    // legitimately accrued *after* that moment.
    const arrived =
      carried.lastDetectionAtMs === null || event.lastDetectionAtMs > carried.lastDetectionAtMs;

    /**
     * The snapshot is the event as it stood *before* this tick's arrival. That is what
     * makes gate 1's `redetection.atMs - event.lastDetectionAtMs` a real T_LINK gap rather
     * than a comparison of a value with itself, and it is what keeps the accumulator
     * weighing the passes between the two detections instead of silently marking them
     * `detected`.
     *
     * `hullAreaHa: null` and `peatOrLandfill: false` are the honest values, not
     * placeholders. No function in this repo computes either: there is no land-cover
     * classifier (the reignition path says the same about `fuelBand`), and `FUEL_BANDS` —
     * `grass | mixed | forest` — has no peat or landfill member for one to produce. So
     * `isLargeEvent` decides largeness from `maxFrpMw` alone here, which is a rule a
     * fixture can read off the input; a hull area invented in this file would let a fixture
     * assert a size that no function derived. `null` is also the value `isLargeEvent`
     * already reads as "not measured" rather than "small", so the stricter threshold stays
     * reserved for events we are confident about.
     */
    const snapshot: EventObservationSnapshot = {
      publicId: event.publicId,
      state: declaredNow === null ? carried.state : declaredNow.state,
      centroid: event.centroid,
      lastDetectionAtMs: arrived
        ? (carried.lastDetectionAtMs ?? event.lastDetectionAtMs)
        : event.lastDetectionAtMs,
      lastFrpMw: event.lastFrpMw,
      maxFrpMw: event.maxFrpMw,
      hullAreaHa: null,
      peatOrLandfill: false,
      accumulatedE: carried.accumulatedE,
      geoWeightSpent: carried.geoWeightSpent,
      blindSinceMs: carried.blindSinceMs,
      inactiveSinceMs: carried.inactiveSinceMs,
      officialDeclaration: declaration ?? carried.officialDeclaration,
    };

    /**
     * On the first tick of a brand-new event this fires, and the decision comes back with
     * `reason = 'redetection'` even though nothing was re-detected. That word is emitted
     * knowingly: `LIFECYCLE_REASONS` is a closed vocabulary whose member for "a detection
     * arrived" is this one, and the alternative — minting a reason here, in the driver, for
     * a distinction no rule downstream consults — is worse than a slightly wide word in
     * provenance.
     *
     * In a replay the T_LINK branch of gate 1 always resolves to `active`, because the
     * identity engine only ever attaches a detection that already passed T_LINK; one beyond
     * it seeds a *new* event carrying a `possible_reignition` relation. That gate's
     * `no_change` branch is reachable only in production, where a tick can be handed a
     * detection the identity engine assigned somewhere else.
     */
    const redetection = arrived
      ? { atMs: event.lastDetectionAtMs, source: event.lastDetectionSource }
      : null;

    const evidence = accumulateMissEvidence(
      { event: snapshot, predictor, windowFromMs: sinceMs, windowToMs: atMs, cloud, outages },
      config,
    );
    const decision = decideLifecycle(
      { event: snapshot, evidence, atMs, redetection },
      config,
      clustering,
    );

    results.push({ evidence, decision });
    carry.set(event.publicId, {
      state: decision.state,
      // The reset (module docblock, rule 2). The decision still reports the E it was
      // computed on — that is provenance and must stay true — but the next window starts
      // from zero, because everything in it was answered by the detection.
      accumulatedE: decision.reason === 'redetection' ? 0 : decision.e,
      geoWeightSpent: evidence.geoWeightSpent,
      blindSinceMs: evidence.blindSinceMs,
      inactiveSinceMs: decision.inactiveSinceMs,
      officialDeclaration: decision.officialDeclaration,
      // Recorded verbatim, every tick: the next tick's arrival test has to be against the
      // same "newest acquisition" the engine reports, or the two would disagree about which
      // rows are new.
      lastDetectionAtMs: event.lastDetectionAtMs,
    });
  }

  return { results, carry };
}

/**
 * The statement in force at `atMs`: the greatest `declaredAtMs` that is not in the future.
 *
 * A statement dated after the decision instant is not standing *yet* — letting one leak
 * into the snapshot would make a replay of last September reach this September's
 * conclusion, which is the one thing the whole lifecycle layer is built not to do.
 *
 * Ties are broken by `(state, attribution)` rather than by array position, so two
 * statements bearing the same instant resolve to the same one whichever order the fixture
 * listed them in. Positional resolution would make the answer a property of a JSON file's
 * formatting; there is no more meaningful tie-break available, because two authorities
 * speaking at the same recorded millisecond is a curation conflict this layer cannot
 * adjudicate.
 */
function standingDeclaration(
  declarations: readonly OfficialDeclaration[],
  atMs: EpochMs,
): OfficialDeclaration | null {
  const standing = declarations
    .filter((declaration) => declaration.declaredAtMs <= atMs)
    .sort(compareDeclarations);
  return standing.at(-1) ?? null;
}

/**
 * A total order over statements. Strings compare by UTF-16 code unit rather than through
 * `localeCompare`, for the same reason the rest of the core does: a collation that depends
 * on where the process runs would make a replay's answer depend on it too, and attributions
 * are Cyrillic agency names where the two orders genuinely differ.
 */
function compareDeclarations(a: OfficialDeclaration, b: OfficialDeclaration): number {
  if (a.declaredAtMs !== b.declaredAtMs) return a.declaredAtMs - b.declaredAtMs;
  if (a.state !== b.state) return a.state < b.state ? -1 : 1;
  if (a.attribution === b.attribution) return 0;
  return a.attribution < b.attribution ? -1 : 1;
}

/**
 * Fail-loud on the three inputs no caller can be wrong about recoverably. A non-finite
 * instant poisons every comparison downstream of it; a backwards window would hand the
 * accumulator an interval it reads as empty and quietly produce a tick that weighed
 * nothing; and one `public_id` twice in a list means two answers race to be the event's
 * one state, with the loser's evidence silently discarded from the carry.
 */
function assertRequest(request: LifecycleTickRequest): void {
  const { atMs, sinceMs } = request;
  if (!Number.isFinite(atMs)) {
    throw new RangeError(
      `the lifecycle tick instant must be a finite epoch millisecond, got ${String(atMs)}`,
    );
  }
  if (!Number.isFinite(sinceMs)) {
    throw new RangeError(
      `the lifecycle tick window must start at a finite epoch millisecond, got ${String(sinceMs)}`,
    );
  }
  if (sinceMs > atMs) {
    throw new RangeError(
      `the lifecycle tick window ends before it starts: [${String(sinceMs)}, ${String(atMs)})`,
    );
  }
  const seen = new Set<string>();
  for (const event of request.events) {
    if (seen.has(event.publicId)) {
      throw new RangeError(`${event.publicId} appears twice in one lifecycle tick`);
    }
    seen.add(event.publicId);
  }
}
