/**
 * When a satellite should have been able to look at a point (TASKS D4; ADR-002 D6 as
 * amended by A2.3; GLOSSARY §3b freshness chip).
 *
 * The E-accumulator's whole question is "did something that should have seen this fire
 * fail to see it", and that question is unanswerable without a model of the constellation.
 * It is a port for the usual reason plus one specific to it: the v0 implementation is a
 * static pass-time table fitted to WP1's observed arrival times, and it will be replaced
 * by a real propagator without the accumulator noticing.
 *
 * Two properties are load-bearing:
 *
 *   - **It answers about the past, not only the future.** A replay of last September asks
 *     what the constellation was *then* — including sources that have since retired
 *     (A2.3(2)). `expectedPasses` is therefore a pure function of an instant range, and a
 *     source's `statusEffectiveFrom` is part of the answer, never a filter applied after.
 *   - **It says nothing about health.** A satellite that was overhead while its feed was
 *     down still had an expected pass; whether that pass may weigh on E is the
 *     accumulator's decision under the per-source freeze (A2.3(1)). Mixing the two here
 *     would make an outage indistinguishable from a retirement, which is exactly the
 *     deadlock A2.3 closes.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { Coordinate } from '../clustering/geometry.js';
import type { EpochMs } from './clock.js';

/**
 * The two halves of the day, as the miss weights and the "misses spanning both diurnal
 * phases" condition mean them. Not a sun-angle computation: it is which of a polar
 * source's two daily passes this was, because that is what the weight table is indexed by
 * and what the transition condition is asking about.
 */
export const DIURNAL_PHASES = ['day', 'night'] as const;
export type DiurnalPhase = (typeof DIURNAL_PHASES)[number];

/** One overpass the constellation was expected to make over a point. */
export interface ExpectedPass {
  readonly source: SourceId;
  /** The instant of closest approach, UTC. */
  readonly atMs: EpochMs;
  readonly phase: DiurnalPhase;
}

/**
 * When we expect the *user* to know more — the freshness chip's `~HH:MM–HH:MM`
 * (GLOSSARY §3b). It is the expected pass plus the typical delivery lag, never a promise
 * that an overpass will happen or that it will see anything. `null` is a legitimate
 * answer and renders `freshness_chip_unknown`; a guessed range is not allowed.
 */
export interface PassWindow {
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
}

export interface PassPredictor {
  /**
   * The version of the pass model that produced these answers, recorded on anything
   * derived from them so a later refit is visible rather than silent.
   */
  readonly tableVersion: string;

  /**
   * Passes expected over `at` in the half-open interval `[fromMs, toMs)`, sorted by
   * `(atMs, source)`. Sorted rather than "in whatever order the table iterates", because
   * E is a sum of floats and a float sum is only reproducible at a fixed order.
   */
  expectedPasses(at: Coordinate, fromMs: EpochMs, toMs: EpochMs): readonly ExpectedPass[];

  /** The next window after `fromMs`, or `null` when the model has none. */
  nextWindow(at: Coordinate, fromMs: EpochMs): PassWindow | null;
}
