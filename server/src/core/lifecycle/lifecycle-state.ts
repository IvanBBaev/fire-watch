/**
 * The lifecycle state machine, as a side-effect-free function (TASKS D4; ADR-002 D6 as
 * amended by A2.2, A2.3 and A1.3; 12 §4.3).
 *
 * `e-accumulator.ts` answers *how much evidence there is that nothing saw this fire*.
 * This file answers *what we are therefore allowed to say*, and the two are deliberately
 * different jobs. Accumulating is arithmetic over a constellation model; concluding is a
 * rule set with hard non-E conditions bolted on top of it, and one of those conditions
 * (A2.3(3)) closes an event **regardless of E** — a rule the accumulator could not
 * express without knowing that closing is possible.
 *
 * What this function refuses to do matters more than what it does:
 *
 *   - **It never concludes that a fire is out.** The state vocabulary has no such value
 *     (`packages/contracts/src/lifecycle.ts`), so the claim is unrepresentable rather than
 *     merely undesirable. `no_longer_detected` is the strongest thing satellite data can
 *     support, and it says exactly what it says.
 *   - **It never sets or clears an `officially_*` state.** Only an attributed statement
 *     does, in both directions (A2.2). There is no branch here that produces a curated
 *     state, and {@link decideLifecycle} throws rather than emit one it was not handed —
 *     an executable invariant rather than a comment nobody re-reads.
 *   - **It never reads a clock.** The decision instant is `input.atMs`, so a replay of
 *     last September reaches last September's conclusion (I5, CI-2).
 *   - **It never resets E.** A detection returns the event to `active` here, but the
 *     running total belongs to the accumulator; if a caller feeds a stale E back in on
 *     the next tick, this function will close the event again on it. The seam is the
 *     accumulator's to keep honest, and it is stated here so the next reader does not
 *     look for the reset in the wrong file.
 *
 * ## The one place a display concern lives in a state machine
 *
 * A1.3's 48 h / 7 d windows are **status transitions written by this tick**, never
 * wall-clock filters applied when a snapshot is built — a filter would leave the last
 * event of the season sitting in client stores forever, because no `seq` would ever move
 * to evict it. So the tier is computed here, alongside the state, from the same instant.
 *
 * The window is measured from `inactiveSinceMs` — the instant the transition was written,
 * not the last detection — and this function returns that anchor alongside the tier, so
 * the tick that closes an event is also the tick that opens its 48 h on the map.
 */

import { isCuratedLifecycleState } from '@fire-watch/contracts';
import type { LifecycleState, SourceId } from '@fire-watch/contracts';

import {
  CLUSTERING_PARAMS,
  tLinkMs,
  type ClusteringParams,
} from '../clustering/clustering-params.js';
import { LIFECYCLE_PARAMS, quantizeE, type LifecycleParams } from '../config/lifecycle-params.js';
import type { VersionedConfig } from '../config/versioned-config.js';
import type { EpochMs } from '../ports/clock.js';
import { DIURNAL_PHASES } from '../ports/pass-predictor.js';
import type {
  DisplayTier,
  EventObservationSnapshot,
  LifecycleDecision,
  LifecycleReason,
  MissEvidence,
} from './types.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * One event, one instant, one window's worth of miss evidence.
 *
 * `redetection` is the tick's news: a detection that attached to this event under
 * Decision 2 inside this window, or `null`. It is passed separately from
 * {@link EventObservationSnapshot.lastDetectionAtMs} because the A2.2 rule is about the
 * *gap between the two* — the detection that arrived and the one the event already had —
 * and folding the new one into the snapshot first would erase the very number the rule
 * is asking about.
 */
export interface LifecycleTickInput {
  readonly event: EventObservationSnapshot;
  readonly evidence: MissEvidence;
  readonly atMs: EpochMs;
  /** A detection that arrived in this tick's window, or `null`. */
  readonly redetection: { readonly atMs: EpochMs; readonly source: SourceId } | null;
}

/**
 * Where `signal_weakening` begins, as a fraction of whichever E threshold applies.
 *
 * The ADR names three numbers for this ladder — 3.0, 5.0 and 24 h — and none of them is
 * the middle rung, so the middle rung has to be derived rather than invented. Half the
 * closing threshold is the derivation, for three reasons:
 *
 *   1. **It is one ladder, not two.** A refit that moves `eThreshold` to 3.5 in
 *      `lifecycle_params_v2` moves the whole ladder coherently; a second fitted constant
 *      would have to be refitted alongside it and, one season from now, would not be.
 *   2. **It scales with the large-event bar for free.** A large event weakens at 2.5
 *      rather than 1.5, which is the same statement the stricter closing bar makes: we
 *      are slower to say anything at all about a big fire.
 *   3. **It cannot be reached by noise.** 1.5 is more than one missed VIIRS night pass
 *      (1.25), more than a whole day of GEO slots (capped at 1.0) and three times a
 *      missed MODIS pass. "The signal is weakening" then means at least two independent
 *      opportunities went unanswered, which is what a user reading the word expects.
 *
 * If a season's data ever argues for a different fraction it stops being a derivation and
 * becomes a fitted number, and a fitted number belongs in `lifecycle_params` with a
 * version bump — not here.
 */
export const SIGNAL_WEAKENING_THRESHOLD_FRACTION = 0.5;

/**
 * Large by any one of D6's three criteria. `null` is not large: a missing hull area is an
 * event we have not measured, not a small one, and the stricter threshold exists to slow
 * us down where we are confident the fire is big — never to slow us down where we know
 * nothing.
 *
 * `peatOrLandfill` is a fact the caller asserts rather than a fuel band, because the D10
 * vocabulary (`grass | mixed | forest`) cannot express it; the parameter
 * `peatOrLandfillIsLarge` is what makes the criterion itself versioned data.
 */
export function isLargeEvent(
  // Only the three facts the rule reads, so FER (core/qa) judges the large-event class
  // with this implementation from the transition log's snapshot rather than a copy.
  event: Pick<EventObservationSnapshot, 'hullAreaHa' | 'maxFrpMw' | 'peatOrLandfill'>,
  params: LifecycleParams = LIFECYCLE_PARAMS.values,
): boolean {
  const { largeEvent } = params;
  if (event.hullAreaHa !== null && event.hullAreaHa >= largeEvent.hullAreaHa) return true;
  if (event.maxFrpMw !== null && event.maxFrpMw >= largeEvent.maxFrpMw) return true;
  return event.peatOrLandfill && largeEvent.peatOrLandfillIsLarge;
}

/** The E bar that applies, so a report can say 3.0 or 5.0 rather than "the threshold". */
export function eThresholdFor(
  large: boolean,
  params: LifecycleParams = LIFECYCLE_PARAMS.values,
): number {
  return large ? params.eThresholdLarge : params.eThreshold;
}

/** The middle rung of the ladder — see {@link SIGNAL_WEAKENING_THRESHOLD_FRACTION}. */
export function signalWeakeningThreshold(
  large: boolean,
  params: LifecycleParams = LIFECYCLE_PARAMS.values,
): number {
  return quantizeE(eThresholdFor(large, params) * SIGNAL_WEAKENING_THRESHOLD_FRACTION, params);
}

/**
 * A1.3's display window: where an event shows, given how long it is since it went
 * inactive.
 *
 * **The clock runs from the transition, not from the last detection.** A1.3 grants the
 * event 48 h on the map *after it goes inactive*, and says in as many words that it "does
 * not vanish from the product at the moment of the state transition" — so the transition
 * starts the window rather than being a point already inside it. The anchor is therefore
 * {@link EventObservationSnapshot.inactiveSinceMs}. Measuring from `lastDetectionAtMs`
 * would spend most of the window before the transition could even be written — a close
 * needs 24 h of silence before it can be considered — and would spend all of it on an
 * event closed by the 14-day unobservability fallback, which is the one case where the
 * user most needs to see that the fire was *lost* rather than ended.
 *
 * Both boundaries are closed at the bottom in the direction of *less* reach: at exactly
 * 48 h the event has left the map, at exactly 7 d it has left the active set. Same
 * convention as the cloud gate, and for the same reason — the boundary value has to be
 * reachable by a fixture rather than decided by which side of it a float landed on.
 *
 * ## Fade-and-persist, and the decision this function refuses to pre-empt
 *
 * D6 says large events "fade on the map but persist listed" (ADR-002 D6): they fade *off*
 * the map and persist *listed*. That is the ladder every event already walks — `map`
 * while the window is open, then `feed`, which is exactly "listed but not drawn" — so
 * `large` has no effect on the tier and is deliberately not a parameter here. An earlier
 * draft held large events at `map` for the whole week; that is the opposite of what the
 * line says.
 *
 * The stronger behaviour on the table — large events keeping a burnt perimeter for the
 * season — is an **unresolved product decision, not an omission**:
 * `docs/reviews/00-summary.md` § "Open questions escalated across reviews" lists
 * "Fade-and-persist vs. removal for 'no longer detected' events (11 Q9 ↔ 07 Q5) …
 * large events keep burnt perimeter for the season — needs a product decision". A state
 * machine that anticipated it would write an unratified product call into every row, and
 * rows outlive decisions. When it is ratified it arrives as data — a `lifecycle_params`
 * field with a version bump — so that a tier can always be traced to the rule that set it.
 *
 * `active` and `signal_weakening` are always `map`, and carry no anchor at all.
 * `signal_weakening` is an event that is still burning as far as anyone knows — the
 * signal is what is weakening, not the fire — so it has not gone inactive and its window
 * has not started.
 */
export function displayTierFor(
  state: LifecycleState,
  msSinceInactive: number,
  params: LifecycleParams = LIFECYCLE_PARAMS.values,
): DisplayTier {
  if (state === 'archived') return 'archive';
  if (state === 'active' || state === 'signal_weakening') return 'map';
  // `no_longer_detected` and the two curated states age on the same clock: whatever an
  // authority declared, an event a week past its transition is not active-set content.
  if (msSinceInactive >= params.activeFeedHours * HOUR_MS) return 'archive';
  return msSinceInactive >= params.mapWindowHours * HOUR_MS ? 'feed' : 'map';
}

/**
 * Decides what this event's state and display tier should be after this tick.
 *
 * The gates are ordered by authority and the order is load-bearing:
 *
 *   1. **A detection outranks every inference.** Whatever E says, something saw the fire.
 *   2. **A curated state is not ours to move** (A2.2, second bullet). Satellite data
 *      never sets *or clears* an `officially_*` state, and "clears" includes downgrading
 *      one to `no_longer_detected` on mounting miss evidence. Only the tier ages.
 *   3. **`archived` is where the machine ladder ends.** A detection near an archived
 *      event is past T_LINK and mints a *new* event with a `possible_reignition`
 *      relation — the identity engine's job (ADR-002 D2), not this function's.
 *   4. **The miss-evidence transition is tried before the unobservability fallback.**
 *      When both would fire, the transition genuinely *is* a miss-evidence conclusion and
 *      must be counted in the FER numerator; letting the fallback answer first would
 *      stamp `excludedFromFer` on it and quietly improve the metric the fallback exists
 *      to be kept out of.
 *
 * Downstream, the return to `active` at gate 1 rides an **`escalation`, never a
 * `new_fire`** (A2.2, third bullet; ADR-004 D3): the zone has already been told about
 * this event, and re-announcing it as new would be a second first-alert about one fire.
 * This function emits no alerts — it is said here because the next reader of the
 * `redetection` reason is the person deciding what to send.
 */
export function decideLifecycle(
  input: LifecycleTickInput,
  config: VersionedConfig<LifecycleParams> = LIFECYCLE_PARAMS,
  clustering: ClusteringParams = CLUSTERING_PARAMS.values,
): LifecycleDecision {
  assertTickInput(input);

  const params = config.values;
  const { event, evidence, atMs, redetection } = input;

  const large = isLargeEvent(event, params);
  const eThreshold = eThresholdFor(large, params);
  const e = quantizeE(evidence.e, params);
  const sinceLastDetectionMs = atMs - event.lastDetectionAtMs;

  /**
   * The A1.3 anchor this decision leaves behind: `null` for the two detected states, the
   * carried-in value for an event that was already out of them, and `atMs` on the tick
   * that takes it out — which is what makes the transition, rather than the last
   * detection, the start of the display window.
   *
   * The `?? atMs` also covers an event handed in already out of the detected states with
   * no anchor — a backfilled row, or a curated state written by a declaration path that
   * did not set one. Restarting its window from this tick is the conservative direction:
   * it can only ever grant more visibility than the truth, never less, and the caller
   * persists the value so it does not restart again.
   */
  const anchorFor = (state: LifecycleState): EpochMs | null =>
    state === 'active' || state === 'signal_weakening' ? null : (event.inactiveSinceMs ?? atMs);

  const tierFor = (state: LifecycleState): DisplayTier => {
    const anchor = anchorFor(state);
    return displayTierFor(state, anchor === null ? 0 : atMs - anchor, params);
  };

  const conclude = (
    state: LifecycleState,
    reason: LifecycleReason,
    excludedFromFer = false,
  ): LifecycleDecision => {
    // Rule 6 as an assertion rather than a review comment. Nothing below can reach this,
    // which is the point: if a future branch ever could, it fails loudly in CI instead of
    // teaching the product to declare containment from a pixel.
    if (isCuratedLifecycleState(state) && state !== event.state) {
      throw new RangeError(
        `the lifecycle tick tried to put ${event.publicId} into ${state}; only an attributed official statement may set a curated state`,
      );
    }
    return {
      publicId: event.publicId,
      atMs,
      fromState: event.state,
      state,
      displayTier: tierFor(state),
      reason,
      e,
      eThreshold,
      large,
      excludedFromFer,
      officialDeclaration: event.officialDeclaration,
      inactiveSinceMs: anchorFor(state),
      paramsVersion: config.version,
    };
  };

  // ── 1. a detection arrived (A2.2) ──────────────────────────────────────────────────
  if (redetection !== null) {
    // Measured between the two detections, not from the decision instant: T_LINK is the
    // same-event temporal gap the identity engine attaches on, and asking a different
    // question here would let the two disagree about one fire. A non-positive gap is a
    // late-arriving row whose acquisition precedes one we already hold — inside the
    // window by construction.
    if (redetection.atMs - event.lastDetectionAtMs <= tLinkMs(clustering)) {
      // Back among the detected states, so the anchor is cleared: a later close starts a
      // fresh 48 h rather than resuming a window this fire has left.
      return conclude('active', 'redetection');
    }
    // Past T_LINK the reignition rule applies instead: a new event carrying a
    // `possible_reignition` relation back to this one. That is identity's decision, so
    // this tick makes none — transitioning here would give the same fire two rows'
    // worth of lifecycle and the zone two escalations.
    return conclude(event.state, 'no_change');
  }

  // ── 2. a curated state, with no detection to contradict it ─────────────────────────
  if (isCuratedLifecycleState(event.state)) {
    const tier = tierFor(event.state);
    return conclude(event.state, tier === 'map' ? 'no_change' : 'display_window');
  }

  // ── 3. archived ────────────────────────────────────────────────────────────────────
  if (event.state === 'archived') {
    return conclude('archived', 'no_change');
  }

  // ── 4. already closed: only the display window still moves it ──────────────────────
  if (event.state === 'no_longer_detected') {
    const tier = tierFor('no_longer_detected');
    if (tier === 'archive') return conclude('archived', 'display_window');
    return conclude('no_longer_detected', tier === 'map' ? 'no_change' : 'display_window');
  }

  // Everything below decides for an `active` or `signal_weakening` event.

  // ── 5. the transition, and all three conditions of it ──────────────────────────────
  //
  // None of the three is tradeable against the others, which is why they are three
  // booleans and not a weighted sum. The dwell condition stops an event closing on a
  // burst of misses in the hours after a detection; the diurnal condition stops a run of
  // cloudy afternoons closing an event that nothing has looked at by night. E alone,
  // without either, would let a thick constellation close a fire it saw two hours ago.
  const eMet = e >= quantizeE(eThreshold, params);
  const dwellMet = sinceLastDetectionMs >= params.minHoursSinceLastDetection * HOUR_MS;
  const phasesMet =
    !params.requireBothDiurnalPhases ||
    DIURNAL_PHASES.every((phase) => evidence.phasesWithMisses.includes(phase));

  if (eMet && dwellMet && phasesMet) {
    // The anchor is written here, so the tier on this tick is `map`: A1.3's window opens
    // at the transition and the event is drawn for another 48 h from now.
    return conclude('no_longer_detected', 'miss_evidence');
  }

  // ── 6. A2.3(3): the hard unobservability fallback ──────────────────────────────────
  //
  // Both halves, and both are needed. `trailingUnobservableDays` is the "zero accumulable
  // overpasses" half and is taken from the accumulator rather than re-derived from
  // `passes` here — re-deriving it would be a second definition of what an opportunity
  // is, and the two would eventually disagree about an event nobody could explain. The
  // dwell against `lastDetectionAtMs` is the "zero detections" half: a fortnight of cloud
  // over a fire we detected last Tuesday closes nothing.
  //
  // Closing here writes the anchor like any other transition, so a fortnight-blind event
  // still gets its 48 h on the map. That is deliberate and it is the case A1.3's wording
  // is really about: the user needs to see that this fire was *lost*, not that it ended.
  //
  // `excludedFromFer` is the whole reason this branch is separate from gate 5. FER counts
  // re-attachments after a *miss-evidence* closure; a closure made because observation was
  // impossible is not one, and folding it in would let a bad-weather month improve the
  // number that is supposed to tell us the accumulator is miscalibrated (11 §9.3).
  const blindMs = params.unobservableDays * DAY_MS;
  if (
    evidence.trailingUnobservableDays >= params.unobservableDays &&
    sinceLastDetectionMs >= blindMs
  ) {
    return conclude('no_longer_detected', 'unobservable', true);
  }

  // ── 7. short of the bar ────────────────────────────────────────────────────────────
  //
  // The reason is not `no_change` even when the state does not move, because "why is this
  // event still active?" is a product surface and "nothing happened" answers it badly.
  // `no_opportunity` and `insufficient_evidence` are different diagnoses with different
  // fixes: the first says the constellation could not look (frozen sources, retirement,
  // unbroken cloud), the second says it looked and we are not convinced yet.
  const state: LifecycleState =
    e >= signalWeakeningThreshold(large, params) ? 'signal_weakening' : 'active';
  const reason: LifecycleReason =
    evidence.accumulableOpportunities === 0 ? 'no_opportunity' : 'insufficient_evidence';
  return conclude(state, reason);
}

/**
 * Input validation, fail-loud. Every check below is an inconsistency no caller can
 * recover from silently: a decision computed on a snapshot whose evidence belongs to a
 * different event, or on an instant that precedes the detection it is measuring from, is
 * not a conservative decision — it is an arbitrary one that will be written to a row and
 * published under a `public_id`.
 */
function assertTickInput(input: LifecycleTickInput): void {
  const { event, evidence, atMs, redetection } = input;

  if (!Number.isFinite(atMs)) {
    throw new RangeError(
      `the decision instant must be a finite epoch millisecond, got ${String(atMs)}`,
    );
  }
  if (!Number.isFinite(event.lastDetectionAtMs)) {
    throw new RangeError(
      `${event.publicId}: lastDetectionAtMs must be a finite epoch millisecond, got ${String(event.lastDetectionAtMs)}`,
    );
  }
  if (atMs < event.lastDetectionAtMs) {
    throw new RangeError(
      `${event.publicId}: the decision instant ${String(atMs)} precedes the last detection ${String(event.lastDetectionAtMs)}`,
    );
  }
  if (evidence.publicId !== event.publicId) {
    throw new RangeError(
      `miss evidence for ${evidence.publicId} was handed to a tick for ${event.publicId}`,
    );
  }
  assertEvidence(`${event.publicId}: accumulatedE`, event.accumulatedE);
  assertEvidence(`${event.publicId}: e`, evidence.e);
  assertCount(`${event.publicId}: trailingUnobservableDays`, evidence.trailingUnobservableDays);
  assertCount(`${event.publicId}: accumulableOpportunities`, evidence.accumulableOpportunities);
  assertMetric(`${event.publicId}: hullAreaHa`, event.hullAreaHa);
  assertMetric(`${event.publicId}: maxFrpMw`, event.maxFrpMw);

  // The A1.3 anchor's contract, made executable. A detected state carrying an anchor is a
  // caller that did not clear it on redetection, and the symptom would be an event that
  // silently skips its map window the next time it closes — a display bug that looks like
  // a state-machine bug and would be debugged in the wrong file for a day.
  if (event.inactiveSinceMs !== null) {
    if (!Number.isFinite(event.inactiveSinceMs)) {
      throw new RangeError(
        `${event.publicId}: inactiveSinceMs must be a finite epoch millisecond, got ${String(event.inactiveSinceMs)}`,
      );
    }
    if (event.inactiveSinceMs > atMs) {
      throw new RangeError(
        `${event.publicId}: inactiveSinceMs ${String(event.inactiveSinceMs)} is after the decision instant ${String(atMs)}`,
      );
    }
    if (event.state === 'active' || event.state === 'signal_weakening') {
      throw new RangeError(
        `${event.publicId} is ${event.state} with inactiveSinceMs ${String(event.inactiveSinceMs)}; a detected event has not gone inactive and must carry no display-window anchor`,
      );
    }
  }

  // A curated state exists only because someone was quoted saying so, and the decision
  // carries that quote forward verbatim. One without a declaration is a state we could
  // not attribute, which is the one thing the `officially_*` states are for.
  if (isCuratedLifecycleState(event.state) && event.officialDeclaration === null) {
    throw new RangeError(
      `${event.publicId} is ${event.state} with no official declaration; a curated state must carry the statement that set it`,
    );
  }

  if (redetection !== null) {
    if (!Number.isFinite(redetection.atMs)) {
      throw new RangeError(
        `${event.publicId}: the redetection instant must be a finite epoch millisecond, got ${String(redetection.atMs)}`,
      );
    }
    if (redetection.atMs > atMs) {
      throw new RangeError(
        `${event.publicId}: a redetection at ${String(redetection.atMs)} is after the decision instant ${String(atMs)}`,
      );
    }
  }
}

function assertEvidence(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${label} must be a finite, non-negative miss weight, got ${String(value)}`,
    );
  }
}

function assertCount(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${String(value)}`);
  }
}

function assertMetric(label: string, value: number | null): void {
  if (value === null) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `${label} must be finite and non-negative when present, got ${String(value)}`,
    );
  }
}
