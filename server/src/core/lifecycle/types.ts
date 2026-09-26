/**
 * The vocabulary of the lifecycle tick (TASKS D4; ADR-002 D6 as amended by A2.2, A2.3,
 * A1.3).
 *
 * Everything here is a value, for the same reason `clustering/types.ts` is: a tick is
 * `(event, expected passes, cloud, outages, params) → (miss evidence, decision)`, and the
 * golden replay has to run the same function the live job runs. There is no store and no
 * clock — the decision instant is a parameter, so a replay of last September reaches last
 * September's conclusion (I5).
 *
 * The split between {@link MissEvidence} and {@link LifecycleDecision} is deliberate and
 * is the seam of the whole task: accumulating evidence is arithmetic over a constellation
 * model, deciding a state is a rule set with hard non-E conditions on top. Keeping them
 * apart is what lets the 14-day unobservability fallback close an event *regardless of E*
 * without the accumulator having to know that closing is possible.
 */

import type { CuratedLifecycleState, LifecycleState, SourceId } from '@fire-watch/contracts';

import type { Coordinate } from '../clustering/geometry.js';
import type { EpochMs } from '../ports/clock.js';
import type { DiurnalPhase } from '../ports/pass-predictor.js';

/**
 * An official statement, kept as history for the life of the event (A2.2). Satellite data
 * never sets and never clears one — the transition back to `active` leaves it standing,
 * because "the authority said this on that date" does not stop being true when a pixel
 * arrives afterwards.
 */
export interface OfficialDeclaration {
  readonly state: CuratedLifecycleState;
  readonly declaredAtMs: EpochMs;
  /** The attributed source, as rendered next to the statement. Never derived, never ours. */
  readonly attribution: string;
}

/**
 * GEO miss weight already spent on one UTC day, carried between ticks.
 *
 * `geoSlot.dailyCapWeight` is a ceiling on what *all* of a UTC day's 10-minute slots may
 * contribute together, but a tick only ever sees its own window. Without a carried
 * balance the cap silently becomes per tick, and a job that runs four times a day lets a
 * stationary sensor contribute four times what the parameter says it may.
 */
export interface GeoWeightSpent {
  /** UTC midnight of the day the balance belongs to. A balance naming an earlier day is spent. */
  readonly utcDayStartMs: EpochMs;
  readonly weight: number;
}

/**
 * What a tick needs to know about the event. Narrow on purpose: no detections, no
 * geometry beyond the centroid the predictor asks about, and no score. Lifecycle is not
 * allowed to depend on a judgement call, and the way to guarantee that is to not hand it
 * one.
 */
export interface EventObservationSnapshot {
  readonly publicId: string;
  readonly state: LifecycleState;
  /** Where the predictor is asked about. */
  readonly centroid: Coordinate;
  readonly lastDetectionAtMs: EpochMs;
  /** FRP of the last detection — the GEO slot rule's gate. `null` where none was sent. */
  readonly lastFrpMw: number | null;
  readonly maxFrpMw: number | null;
  readonly hullAreaHa: number | null;
  /** A fact about the fire, not a fuel band: see `LargeEventCriteria.peatOrLandfillIsLarge`. */
  readonly peatOrLandfill: boolean;
  /** Miss evidence carried in from previous ticks. Fresh events start at 0. */
  readonly accumulatedE: number;
  /** The GEO daily balance carried in, or `null` on an event no tick has weighed GEO for. */
  readonly geoWeightSpent: GeoWeightSpent | null;
  /**
   * Where the current unobservable run is counted from, carried in; `null` on an event no
   * tick has weighed yet, in which case the run starts at the window's start.
   *
   * A2.3(3)'s fallback is about *fourteen days* with no accumulable opportunity, and a
   * tick's window is minutes long. Counting whole days inside one window alone would make
   * the fallback unreachable on the live path, which ticks every minute: every window
   * holds zero whole days, so the count never leaves 0 and a fire nothing can see stays
   * `active` on the map forever. The run therefore spans ticks the way `accumulatedE`
   * does — in here, back out through {@link MissEvidence.blindSinceMs}.
   */
  readonly blindSinceMs: EpochMs | null;
  /**
   * When the event stopped being detected — the instant A1.3's display window is measured
   * from. `null` while it is still `active` or `signal_weakening`.
   *
   * Deliberately not `lastDetectionAtMs`. A1.3 grants the event 48 h on the map *after it
   * goes inactive*, and says in as many words that it "does not vanish from the product at
   * the moment of the state transition" — so the transition is the start of the window, not
   * a point already inside it. Anchoring on the last detection would spend most of the
   * window before the transition is written (a close needs 24 h of silence before it can
   * even be considered), and would spend all of it for an event closed by the 14-day
   * unobservability fallback — the one case where the user most needs to see that the fire
   * was *lost* rather than ended.
   *
   * The tick job writes it in the same write that writes the transition and bumps `seq`,
   * which is what keeps A1.3's "status transitions, never wall-clock filters" true of this
   * field too.
   */
  readonly inactiveSinceMs: EpochMs | null;
  readonly officialDeclaration: OfficialDeclaration | null;
}

/** One hour of `cloud_cover`, as the weather context stores it (C3). */
export interface CloudCoverSample {
  readonly hourStartMs: EpochMs;
  /** Percent, 0–100. */
  readonly percent: number;
}

/**
 * A window in which a source was outside its freshness budget. Scoped to the source and
 * nothing else (A2.3(1)): while `source` is blown its passes weigh nothing, and every
 * other source keeps accumulating normally. `toMs` is `null` while the outage is open.
 */
export interface SourceOutage {
  readonly source: SourceId;
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs | null;
}

/** Why a pass contributed what it did — provenance, so "why is this event still active" is answerable. */
export const PASS_VERDICTS = [
  /** Counted, at full weight. */
  'counted',
  /** Counted at half weight: 50–80 % cloud. */
  'half_weight',
  /** Above the cloud ceiling — no accumulation, and not an accumulable opportunity either. */
  'cloud_blocked',
  /** The source was outside its freshness budget at that instant (A2.3(1)). */
  'source_frozen',
  /** The event was detected at or after this pass, so it is not a miss at all. */
  'detected',
  /** GEO slots below the FRP gate, or past the day's cap. */
  'geo_gated',
] as const;
export type PassVerdict = (typeof PASS_VERDICTS)[number];

export interface WeighedPass {
  readonly source: SourceId;
  readonly atMs: EpochMs;
  readonly phase: DiurnalPhase;
  readonly verdict: PassVerdict;
  readonly weight: number;
}

/**
 * The accumulator's answer over one window. `e` is the running total including
 * {@link EventObservationSnapshot.accumulatedE}, already quantised.
 */
export interface MissEvidence {
  readonly publicId: string;
  readonly windowFromMs: EpochMs;
  readonly windowToMs: EpochMs;
  readonly e: number;
  /** What this window alone added — the part a fixture can check independently of history. */
  readonly addedE: number;
  readonly passes: readonly WeighedPass[];
  /** Phases that produced at least one weighed miss, in `DIURNAL_PHASES` order. */
  readonly phasesWithMisses: readonly DiurnalPhase[];
  /**
   * Passes that were a real opportunity to see the fire — anything not `cloud_blocked`,
   * `source_frozen` or `geo_gated`. Zero of these for long enough is what the
   * unobservability fallback is about, and it is deliberately not "zero passes": a
   * satellite that was overhead behind cloud gave us no opportunity either.
   */
  readonly accumulableOpportunities: number;
  /**
   * Trailing whole UTC days with zero accumulable opportunities, counted from the carried
   * {@link EventObservationSnapshot.blindSinceMs} (or the window's start on a fresh event)
   * to the end of the window. UTC rather than local because a day boundary that moves with
   * a DST fold would make the 14-day count depend on where CI runs.
   */
  readonly trailingUnobservableDays: number;
  /**
   * The unobservable run's start as it stands at the end of the window — what the tick job
   * persists so the next tick keeps counting this run rather than restarting it. The start
   * of the UTC day after the window's last accumulable opportunity when it had one; the
   * carried start (or the window's start) when it had none.
   */
  readonly blindSinceMs: EpochMs;
  /**
   * The GEO daily balance as it stands at the end of the window — what the tick job
   * persists so the next tick's cap continues this day rather than restarting it.
   *
   * `null` means there is no balance to carry: nothing has been spent on the UTC day the
   * window ends in. It does **not** mean "this window weighed no slot" — a window whose
   * slots were all cloud-blocked spends nothing yet must still hand on a live balance from
   * earlier in the same day, or the cap silently reopens, which is the whole bug this
   * field closes.
   */
  readonly geoWeightSpent: GeoWeightSpent | null;
  readonly paramsVersion: string;
  readonly tableVersion: string;
}

/**
 * Where an event shows (A1.3). Written by the tick as a transition that bumps `seq`, never
 * evaluated from the wall clock when a snapshot is built — a filter would leave the last
 * event of the season lingering in client stores forever.
 */
export const DISPLAY_TIERS = ['map', 'feed', 'archive'] as const;
export type DisplayTier = (typeof DISPLAY_TIERS)[number];

/** Why the tick concluded what it did. One word, on every decision including the no-ops. */
export const LIFECYCLE_REASONS = [
  'miss_evidence',
  /** ≥14 d with no detections and no accumulable opportunity — closed because we cannot see. */
  'unobservable',
  /** A detection arrived within T_LINK, including on an `officially_*` event (A2.2). */
  'redetection',
  'display_window',
  /** Nothing moved. */
  'no_change',
  /** E is short, or a hard condition is not met yet. */
  'insufficient_evidence',
  /** The source-set is frozen or retired down to nothing that could have seen it. */
  'no_opportunity',
] as const;
export type LifecycleReason = (typeof LIFECYCLE_REASONS)[number];

/**
 * One tick's conclusion about one event. `state` and `displayTier` are always the values
 * the event should hold *after* the tick, equal to the current ones when nothing moved, so
 * a caller writes the row without having to reconstruct a diff.
 */
export interface LifecycleDecision {
  readonly publicId: string;
  readonly atMs: EpochMs;
  readonly fromState: LifecycleState;
  readonly state: LifecycleState;
  readonly displayTier: DisplayTier;
  readonly reason: LifecycleReason;
  readonly e: number;
  /** The threshold that applied, so a report can say 3.0 or 5.0 rather than "the threshold". */
  readonly eThreshold: number;
  readonly large: boolean;
  /**
   * True when this transition must be kept out of the FER numerator (A2.3(3)) — it is not
   * a miss-evidence conclusion and must never be able to flatter the metric.
   */
  readonly excludedFromFer: boolean;
  /**
   * The A1.3 anchor as it stands after this decision: `atMs` on the tick that takes the
   * event out of the detected states, the value carried in while it stays out, and `null`
   * again after a redetection returns it to `active`. The tick job persists it in the same
   * write as `state`, which is what keeps the display window a transition rather than a
   * wall-clock filter.
   */
  readonly inactiveSinceMs: EpochMs | null;
  /** Preserved verbatim across a return to `active`; never set or cleared by satellite data. */
  readonly officialDeclaration: OfficialDeclaration | null;
  readonly paramsVersion: string;
}
