/**
 * shadow-PCR — the gating CP1 criterion (GATES §4 CP1; GLOSSARY §8 PCR; 06 §5.1.2).
 *
 * GATES states it as two clauses over one population:
 *
 *   "of EFFIS-confirmed perimeters ≥ 50 ha intersecting the AOI in the 2026 season, the
 *   fraction for which (a) a FireEvent exists whose detections intersect the perimeter
 *   buffered 2 km with `started_at` ≤ perimeter end date, **and** (b) the
 *   side-effect-free alert-decision function returns an alert for the synthetic grid zone
 *   containing the perimeter centroid"
 *
 * with "the ≥ 10 ha population reported at ≥ 85%: informative, non-gating".
 *
 * ## Where the seam is
 *
 * This function owns the *definition*: which perimeters are in which population, what
 * `started_at ≤ perimeter end` means at the boundary, which zone a centroid falls in,
 * what counts as "returns an alert", and the arithmetic. It owns no geometry and no
 * scoring:
 *
 *   - **`intersectsBufferedPerimeter` is an input.** A polygon buffered by 2 km and
 *     intersected against detection points is PostGIS's job (D2/D3), and a re-implementation
 *     here would be a second, worse definition of the same predicate. The caller asserts
 *     the fact and the report records it per perimeter.
 *   - **The alert outcome is an input.** `decideAlert` needs a score, an alert-state row
 *     folded across the parent chain and a decision instant. Calling it from inside a
 *     metric would hide those; the harness calls it — with the zone this module derives
 *     via {@link gridAlertZone} — and hands back the outcome.
 *
 * Everything between those two facts is here, which is what makes the remaining work
 * wiring rather than judgement.
 *
 * ## PCR is event-based
 *
 * "counted per perimeter covered, never per alert dispatched" (GLOSSARY §8). The
 * denominator is perimeters; a fire that produced forty alerts and a fire that produced
 * one count the same.
 */

import type { DecisionOutcome } from '../alerts/alert-decision.js';
import type { Coordinate } from '../clustering/geometry.js';
import type { EpochMs } from '../ports/clock.js';
import { gridZoneFor } from './grid-zones.js';
import { ALERTING_OUTCOMES, QA_METRICS, type QaMetricsParams } from './qa-metrics-params.js';
import { meetsAtLeast, rateOf, type Rate } from './rate.js';

/** A FireEvent considered against one perimeter. */
export interface PerimeterCandidateEvent {
  readonly publicId: string;
  /**
   * Do this event's detections intersect the perimeter buffered by
   * `perimeters.bufferKm`? A geometry fact the caller computes; see the header.
   */
  readonly intersectsBufferedPerimeter: boolean;
  readonly startedAtMs: EpochMs;
}

/** What `decideAlert` returned for one `(grid zone, event)` pair. */
export interface ZoneAlertOutcome {
  readonly zoneId: string;
  readonly eventPublicId: string;
  readonly outcome: DecisionOutcome;
}

export interface PerimeterCase {
  readonly perimeterId: string;
  readonly areaHa: number;
  /**
   * The perimeter centroid, which selects the grid zone. EFFIS gives a polygon; the
   * centroid is the caller's, computed the same way for every perimeter.
   */
  readonly centroid: Coordinate;
  /** The perimeter's end date, as the instant criterion (a) compares `started_at` against. */
  readonly endAtMs: EpochMs;
  readonly candidates: readonly PerimeterCandidateEvent[];
  /**
   * Outcomes for the events above. May contain rows for zones other than the perimeter's
   * own — a fire whose detections straddle a cell edge is evaluated in every zone it
   * touches — and only the centroid's zone is consulted.
   */
  readonly zoneDecisions: readonly ZoneAlertOutcome[];
}

export interface ShadowPcrInput {
  /**
   * The season's qualifying perimeters, in a stable order the caller chose (the report
   * preserves it rather than imposing a string collation, which is locale-shaped).
   * Duplicate ids are rejected: a repeated perimeter is a double-counted denominator.
   */
  readonly perimeters: readonly PerimeterCase[];
}

export type PerimeterExclusion = 'centroid_outside_lattice';

export interface PerimeterVerdict {
  readonly perimeterId: string;
  readonly areaHa: number;
  /** The lattice cell holding the centroid, or `null` when it falls outside. */
  readonly zoneId: string | null;
  /** Events meeting criterion (a), in input order. */
  readonly coveringEventIds: readonly string[];
  /** Of those, the ones criterion (b) also holds for. */
  readonly alertingEventIds: readonly string[];
  readonly covered: boolean;
  readonly alerted: boolean;
  /** (a) and (b) — what PCR's numerator counts. */
  readonly counted: boolean;
  readonly excluded: PerimeterExclusion | null;
}

export interface ShadowPcrStratum {
  readonly minAreaHa: number;
  readonly gating: boolean;
  readonly targetRate: number;
  /** Both criteria — the graded number. */
  readonly rate: Rate;
  /**
   * Criterion (a) alone. Not a CP1 threshold; reported because a shadow-PCR miss has two
   * very different causes — we never saw the fire, or we saw it and would not have told
   * anyone — and a single fraction cannot distinguish them.
   */
  readonly coverageOnly: Rate;
  /** GATES §4 CP1 "Minimum n", applied to the gating population. */
  readonly underPowered: boolean;
  readonly meetsTarget: boolean | null;
}

export interface ShadowPcrReport {
  readonly configVersion: string;
  readonly configDigest: string;
  readonly strata: readonly ShadowPcrStratum[];
  /** The per-perimeter table CP1 asks for as its evidence artifact. */
  readonly perimeters: readonly PerimeterVerdict[];
  /**
   * Perimeters in neither numerator nor denominator, with the reason. Listed rather than
   * counted, because an exclusion that cannot be named one by one is a place to hide a
   * miss.
   */
  readonly excluded: readonly PerimeterVerdict[];
}

export function shadowPcr(
  input: ShadowPcrInput,
  params: QaMetricsParams = QA_METRICS.values,
): ShadowPcrReport {
  const seen = new Set<string>();
  const verdicts: PerimeterVerdict[] = [];

  for (const perimeter of input.perimeters) {
    if (seen.has(perimeter.perimeterId)) {
      throw new RangeError(`duplicate perimeter ${JSON.stringify(perimeter.perimeterId)}`);
    }
    seen.add(perimeter.perimeterId);
    if (!Number.isFinite(perimeter.areaHa) || perimeter.areaHa < 0) {
      throw new RangeError(
        `perimeter ${perimeter.perimeterId} needs a non-negative area, got ${String(perimeter.areaHa)}`,
      );
    }
    verdicts.push(gradePerimeter(perimeter, params));
  }

  const graded = verdicts.filter((verdict) => verdict.excluded === null);
  const strata = params.perimeters.strata.map((stratum) => {
    const population = graded.filter((verdict) => verdict.areaHa >= stratum.minAreaHa);
    const rate = rateOf(population.filter((verdict) => verdict.counted).length, population.length);
    return Object.freeze({
      minAreaHa: stratum.minAreaHa,
      gating: stratum.gating,
      targetRate: stratum.targetRate,
      rate,
      coverageOnly: rateOf(
        population.filter((verdict) => verdict.covered).length,
        population.length,
      ),
      underPowered: stratum.gating && population.length < params.perimeters.minimumN,
      meetsTarget: meetsAtLeast(rate, stratum.targetRate, params),
    });
  });

  return Object.freeze({
    configVersion: QA_METRICS.version,
    configDigest: QA_METRICS.digest,
    strata: Object.freeze(strata),
    perimeters: Object.freeze(verdicts),
    excluded: Object.freeze(verdicts.filter((verdict) => verdict.excluded !== null)),
  });
}

function gradePerimeter(perimeter: PerimeterCase, params: QaMetricsParams): PerimeterVerdict {
  const zone = gridZoneFor(perimeter.centroid, params);
  // Criterion (a). `≤` is the document's operator: a fire that started on the perimeter's
  // last day is the fire that burned it, and a strict `<` would drop exactly the
  // single-day fires the ≥ 50 ha population is full of.
  const covering = perimeter.candidates.filter(
    (candidate) =>
      candidate.intersectsBufferedPerimeter && candidate.startedAtMs <= perimeter.endAtMs,
  );
  const coveringEventIds = covering.map((candidate) => candidate.publicId);
  const covered = coveringEventIds.length > 0;

  if (zone === null) {
    return Object.freeze({
      perimeterId: perimeter.perimeterId,
      areaHa: perimeter.areaHa,
      zoneId: null,
      coveringEventIds: Object.freeze(coveringEventIds),
      alertingEventIds: Object.freeze([]),
      covered,
      alerted: false,
      counted: false,
      excluded: 'centroid_outside_lattice',
    });
  }

  // Criterion (b), against the centroid's zone only. An event whose detections span two
  // cells is decided in both, and a `send` in the neighbouring cell is not an alert for
  // *this* perimeter's zone — the definition names one zone, and a report that accepted
  // any of them would grade a coarser system than the one we would ship.
  const coveringIds = new Set(coveringEventIds);
  const alerting = new Set<string>();
  for (const decision of perimeter.zoneDecisions) {
    if (decision.zoneId !== zone.zoneId) continue;
    if (!coveringIds.has(decision.eventPublicId)) continue;
    if (!ALERTING_OUTCOMES.includes(decision.outcome)) continue;
    alerting.add(decision.eventPublicId);
  }
  const alertingEventIds = coveringEventIds.filter((id) => alerting.has(id));

  return Object.freeze({
    perimeterId: perimeter.perimeterId,
    areaHa: perimeter.areaHa,
    zoneId: zone.zoneId,
    coveringEventIds: Object.freeze(coveringEventIds),
    alertingEventIds: Object.freeze(alertingEventIds),
    covered,
    alerted: alertingEventIds.length > 0,
    counted: covered && alertingEventIds.length > 0,
    excluded: null,
  });
}
