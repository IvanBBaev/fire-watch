/**
 * `lifecycle_params_v1` — every number the lifecycle tick is allowed to consult
 * (TASKS D4; ADR-002 D6 as amended by A2.2, A2.3 and A1.3; 11 §5).
 *
 * Versioned data rather than constants for the reason D5 gives generally and one that is
 * specific to this table: the miss weights are a *fit*, not a definition. They came out of
 * 11 §5 as a first calibration, and the FER guardrail below exists precisely so that they
 * get refitted. A refit that edited constants in place would silently change what every
 * archived `no_longer_detected` transition meant; a refit that bumps to
 * `lifecycle_params_v2` leaves last season's transitions readable as what they were.
 *
 * ## Two numbers here are placeholders and say so
 *
 * {@link GeoSlotRule.detectionFloorMw} is 11 §5.3's ~10–30 MW placeholder pending the MTG
 * FRP-PIXEL validation report's stated minimum at BG's 55–60° view zenith (11 §9.8). It is
 * pinned at the **top** of that range on purpose: a higher floor means GEO contributes
 * miss evidence less often, and the direction to be wrong in is the one that keeps an
 * event `active` longer, never the one that declares a burning fire undetected.
 *
 * The weights themselves are unvalidated against Bulgarian fires — WP1 has not run a
 * season yet. That is not a reason to leave the rule unimplemented; it is a reason the
 * version is `_v1`.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { DiurnalPhase } from '../ports/pass-predictor.js';
import { defineConfig, type VersionedConfig } from './versioned-config.js';

/** What a missed pass of a polar source weighs, by which pass it was. */
export type PassMissWeight = Readonly<Record<DiurnalPhase, number>>;

/**
 * The geostationary contribution, which is not a per-pass weight because a GEO sensor has
 * no passes — it looks continuously. Missing from every 10-minute slot for a day is much
 * weaker evidence than one missed VIIRS overpass, so the slots are worth 0.05 each and are
 * capped at a day's worth of one polar pass.
 */
export interface GeoSlotRule {
  readonly weightPerSlot: number;
  readonly slotMinutes: number;
  /** Ceiling on what all of a UTC day's slots may contribute together. */
  readonly dailyCapWeight: number;
  /**
   * GEO only counts as a witness while the fire was recently bright enough for GEO to have
   * had a chance: last FRP ≥ this multiple of {@link detectionFloorMw}. Below that, GEO not
   * seeing it is not evidence of anything.
   */
  readonly frpFloorMultiple: number;
  readonly detectionFloorMw: number;
}

/**
 * The hourly `cloud_cover` gate (ADR-002 D6). Bands are closed at the bottom in the
 * direction of *less* accumulation: exactly 80 % is still half weight, exactly 50 % is
 * still half weight, and only below 50 % does a pass count in full.
 */
export interface CloudGate {
  /** Above this percentage a pass contributes nothing. */
  readonly blockAbovePercent: number;
  /** From this percentage up to {@link blockAbovePercent}, a pass contributes half. */
  readonly halfWeightFromPercent: number;
  readonly halfWeightFactor: number;
}

/** What makes an event "large" for the purposes of the stricter threshold. */
export interface LargeEventCriteria {
  readonly hullAreaHa: number;
  readonly maxFrpMw: number;
  /**
   * Peat and landfill fires smoulder under a surface that satellites read as cold, so they
   * are large by character regardless of size. The fuel vocabulary D10 owns
   * (`grass | mixed | forest`) has no peat or landfill band yet, so the caller passes this
   * as a fact about the event rather than deriving it from a band that cannot express it.
   */
  readonly peatOrLandfillIsLarge: boolean;
}

export interface LifecycleParams {
  /**
   * Per-source miss weight. `null` marks a source that has no passes to miss — the GEO
   * sources, which contribute through {@link geoSlot} instead. Every registry id appears,
   * including retired ones: a replay of a period before a retirement still needs the
   * weight that applied then (A2.3(2)).
   */
  readonly passMissWeights: Readonly<Record<SourceId, PassMissWeight | null>>;
  readonly geoSlot: GeoSlotRule;
  readonly cloudGate: CloudGate;

  /** Miss evidence required to leave `active`, and the stricter bar for large events. */
  readonly eThreshold: number;
  readonly eThresholdLarge: number;
  readonly largeEvent: LargeEventCriteria;

  /**
   * Two conditions that stand alongside E and are not tradeable against it. The diurnal
   * one is what stops a run of cloudy afternoons from closing an event that nothing has
   * looked at by night.
   */
  readonly minHoursSinceLastDetection: number;
  readonly requireBothDiurnalPhases: boolean;

  /**
   * A1.3's hard unobservability fallback: this many consecutive UTC days with zero
   * detections *and* zero accumulable overpasses closes the event regardless of E, with
   * `reason = unobservable` and the `cloud_blind_close` copy.
   */
  readonly unobservableDays: number;

  /**
   * A1.3's display window, in hours. Both are **status transitions written by this job**,
   * never wall-clock filters at snapshot-build time — a filter would leave the last event
   * of the season sitting in client stores forever.
   */
  readonly mapWindowHours: number;
  readonly activeFeedHours: number;

  /**
   * The FER guardrail (re-attach within `ferWindowHours` after `no_longer_detected`).
   * Reported, never enforced: this table cannot refuse to make a transition because a
   * metric is high, it can only be refitted. Kept here so the dashboard and the fixtures
   * cannot disagree about what rate is acceptable.
   */
  readonly ferMaxRate: number;
  readonly ferMaxRateLarge: number;
  readonly ferWindowHours: number;

  /**
   * The quantum every E comparison passes through, mirroring the clustering metric's
   * (Appendix A rule 1). E is a float sum of 0.05s and 1.25s: without it, "exactly 3.0" is
   * unreachable and the threshold is decided by the last bits of an accumulation order.
   */
  readonly eQuantum: number;
}

export const LIFECYCLE_PARAMS: VersionedConfig<LifecycleParams> = defineConfig(
  'lifecycle_params',
  'lifecycle_params_v1',
  {
    passMissWeights: {
      'firms:viirs:snpp': { day: 1.0, night: 1.25 },
      'firms:viirs:noaa20': { day: 1.0, night: 1.25 },
      'firms:viirs:noaa21': { day: 1.0, night: 1.25 },
      'firms:modis': { day: 0.5, night: 0.5 },
      'eumetsat:slstr:frp': { day: 0.75, night: 0.75 },
      'lsasaf:seviri:frp-pixel': null,
      'lsasaf:fci:frp-pixel': null,
    },
    geoSlot: {
      weightPerSlot: 0.05,
      slotMinutes: 10,
      dailyCapWeight: 1.0,
      frpFloorMultiple: 1.5,
      detectionFloorMw: 30,
    },
    cloudGate: {
      blockAbovePercent: 80,
      halfWeightFromPercent: 50,
      halfWeightFactor: 0.5,
    },
    eThreshold: 3.0,
    eThresholdLarge: 5.0,
    largeEvent: {
      hullAreaHa: 100,
      maxFrpMw: 100,
      peatOrLandfillIsLarge: true,
    },
    minHoursSinceLastDetection: 24,
    requireBothDiurnalPhases: true,
    unobservableDays: 14,
    mapWindowHours: 48,
    activeFeedHours: 7 * 24,
    ferMaxRate: 0.05,
    ferMaxRateLarge: 0.1,
    ferWindowHours: 72,
    eQuantum: 1e-6,
  } as const,
);

/**
 * Rounds E to the parameter quantum before any comparison. Same argument as
 * `quantizeKm`: the value that decides a status transition must be the value a fixture can
 * write down, not one that differs in the last bits depending on the order the day's
 * passes happened to arrive in.
 */
export function quantizeE(
  value: number,
  params: LifecycleParams = LIFECYCLE_PARAMS.values,
): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`miss evidence must be finite, got ${String(value)}`);
  }
  return Math.round(value / params.eQuantum) * params.eQuantum;
}
