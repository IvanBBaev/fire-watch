/**
 * The ten features of 11 §3.4, computed from the detections of one event.
 *
 * A pure function of `(detections, context, params)`, in the shape the rest of the core
 * uses: no store, no clock, no I/O. The score is recomputed on every attach and every
 * merge (§3.4), so there is no incremental state to keep and nothing here may depend on
 * *when* it is called — only on what the event is made of.
 *
 * ## Two features are inputs, not derivations, and the type says so
 *
 * x7 `x_fwi` needs the EFFIS Fire Weather Index at the centroid on the first-detection day
 * and x8 `x_agri` needs a majority land cover under the hull. Neither dataset is in this
 * repo: FWI is an un-started adapter and land cover is D10 work. Rather than default them
 * silently — a default is a claim, and "not high fire danger" is a different claim from "we
 * did not look" — they arrive through {@link ScoringContext} as three-valued fields the
 * caller has to fill in. This follows the precedent set for cloud in the lifecycle tick,
 * where the observed cover is a stated input and a missing sample resolves to the verdict
 * whose consequence is right.
 *
 * Both `null`s resolve to 0, and the two directions are not symmetric:
 *
 * - x7 is a **positive** weight, so an unknown FWI costs the event 0.3 of z. Under-crediting
 *   corroboration is safe.
 * - x8 is a **negative** weight, so an unknown land cover *withholds a penalty* and the
 *   score comes out higher than a complete pipeline would produce. That is the wrong
 *   direction, and it is the price of not inventing a land cover. It is recorded here
 *   because the fix is D10, not a constant.
 *
 * ## The static-source mask is not here
 *
 * §3.4's closing line — "proximity to the static hot-source mask and the water/glint guard
 * are hard overrides (§3.6), not features — a weight can be outvoted; a power plant must
 * not be" — is why the mask does not appear in this file at all. It lives in `score.ts`,
 * outside the formula.
 */

import type { SourceId } from '@fire-watch/contracts';

import {
  distanceKm,
  parseCanonicalDegrees,
  withinKm,
  type Coordinate,
} from '../clustering/geometry.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';
import type { DetectionConfidence } from '../ports/detection-store.js';
import { detectionPrior, SCORE_PARAMS, type ScoreParams } from './score-params.js';

/**
 * A detection as the score needs it. Wider than `ClusteringDetection`, which deliberately
 * excludes confidence and FRP so that identity can never depend on a judgement call — this
 * is the judgement call, and it reads exactly the fields identity refuses to.
 */
export interface ScoringDetection {
  readonly detectionUid: string;
  readonly source: SourceId;
  /** `YYYY-MM-DDTHH:MM:00Z`, exactly as hashed into the uid (GLOSSARY §1b). */
  readonly acqTsIso: string;
  /** Canonical 5-decimal degrees, as the archive stores them. */
  readonly latCanonical: string;
  readonly lonCanonical: string;
  /** The decoder-normalized l/n/h, the key of §3.2's table. */
  readonly confidence: DetectionConfidence;
  /** `null` on every GEO row by construction, and read as the day column (§3.2). */
  readonly dayNight: 'D' | 'N' | null;
  /** `null` is "not reported"; `0` is a reported zero (pitfall 9). */
  readonly frpMw: number | null;
  /** Pixel footprint, or `null` where the provider sent none (Appendix A rule 4). */
  readonly scanKm: number | null;
  readonly trackKm: number | null;
  /**
   * §3.6 override 2's input: is this pixel over or adjacent to WorldCover water
   * (03-geodata §5.2.2)? `null` means nothing has been asked — the guard cannot fire on a
   * question nobody put to the land cover, and the detection is kept.
   */
  readonly overOrAdjacentToWater: boolean | null;
}

/** Event-level facts the archive cannot supply, stated by the caller (see the header). */
export interface ScoringContext {
  /**
   * EFFIS FWI class ≥ "high" at the centroid on the first-detection day (x7). `null` =
   * not looked up; scores as 0.
   */
  readonly fwiAtLeastHigh: boolean | null;
  /**
   * Majority land cover under the hull is arable — CORINE 211–213 / WorldCover 40 (x8).
   * `null` = not classified; scores as 0, which withholds a penalty.
   */
  readonly arableMajorityUnderHull: boolean | null;
}

/**
 * The ten features, in the order 11 §3.5 folds them. Every field is in [0,1]; the six
 * binary ones are exactly 0 or 1 and are still numbers, because they are terms of a sum
 * and a boolean would only be converted at the call site.
 */
export interface FeatureVector {
  /** x1 `x_best`: max `c_i`. */
  readonly best: number;
  /** x2 `x_persist`: `min(n_overpasses − 1, 3) / 3`. */
  readonly persist: number;
  /** x3 `x_multisrc`: ≥ 2 distinct platforms. */
  readonly multisrc: number;
  /** x4 `x_night`: any `day_night = 'N'`. */
  readonly night: number;
  /** x5 `x_coherence`: ≥ 3 mutually-close detections inside one overpass. */
  readonly coherence: number;
  /** x6 `x_frp`: `min(ln(1 + FRP_max) / ln(1 + 100), 1)`. */
  readonly frp: number;
  /** x7 `x_fwi`: stated fire-danger class (input). */
  readonly fwi: number;
  /** x8 `x_agri`: stated arable majority (input), a negative weight. */
  readonly agri: number;
  /** x9 `x_edge`: **all** scanning detections from > 2× nadir-area pixels. */
  readonly edge: number;
  /** x10 `x_glint`: **all** detections daytime **and** low confidence. */
  readonly glint: number;
}

/** What the features were computed from — provenance for "why does this event score that". */
export interface FeatureDerivation {
  readonly features: FeatureVector;
  /** Detections left after §3.6's water/glint guard, in input order. */
  readonly retained: readonly ScoringDetection[];
  /** Dropped by the guard, in input order. Normally empty: the guard runs pre-clustering. */
  readonly waterGuarded: readonly ScoringDetection[];
  /** Distinct overpasses and overpass-equivalents behind x2. */
  readonly overpasses: number;
  /** Distinct platform groups behind x3. */
  readonly platforms: number;
  /** Max reported FRP in MW, or `null` when no detection reported one. */
  readonly maxFrpMw: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * §3.6 override 2, as a predicate. The guard is specified *pre-clustering* — daytime
 * low-confidence detections over or adjacent to water never reach an event — so at scoring
 * time this is a backstop, and it is idempotent: a row the ingest path already dropped is
 * not in the list to drop again. It is executable here anyway, because "the pipeline
 * upstream promises to have done it" is not a property a golden fixture can assert.
 */
export function waterGuardDrops(detection: ScoringDetection): boolean {
  return (
    detection.overOrAdjacentToWater === true &&
    detection.dayNight === 'D' &&
    detection.confidence === 'low'
  );
}

/**
 * The ten features of one event.
 *
 * Throws rather than returning a degenerate vector when the event has no detections, or
 * when the guard removes all of them: both describe an event that could not have been
 * created, and a score of "whatever an empty sum comes to" would be a fabricated number
 * with a plausible face.
 */
export function computeFeatures(
  detections: readonly ScoringDetection[],
  context: ScoringContext,
  params: ScoreParams = SCORE_PARAMS.values,
): FeatureDerivation {
  if (detections.length === 0) {
    throw new RangeError('an event with no detections has no features to compute');
  }

  const retained: ScoringDetection[] = [];
  const waterGuarded: ScoringDetection[] = [];
  for (const detection of detections) {
    (waterGuardDrops(detection) ? waterGuarded : retained).push(detection);
  }
  if (retained.length === 0) {
    throw new RangeError(
      'every detection was dropped by the water/glint guard; such an event cannot exist, ' +
        'because the guard runs before clustering',
    );
  }

  const overpassKeys = new Set<string>();
  const platforms = new Set<string>();
  const byOverpass = new Map<string, ScoringDetection[]>();
  let best = 0;
  let maxFrpMw: number | null = null;
  let anyNight = false;
  let allDaytimeLowConfidence = true;
  let scanningCount = 0;
  let allScanningAtSwathEdge = true;

  for (const detection of retained) {
    const acqTs = epochMsFromIso(detection.acqTsIso);
    const key = overpassKey(detection, acqTs, params);
    overpassKeys.add(key);
    platforms.add(params.platformBySource[detection.source]);
    const group = byOverpass.get(key);
    if (group === undefined) byOverpass.set(key, [detection]);
    else group.push(detection);

    const prior = detectionPrior(
      detection.source,
      detection.confidence,
      detection.dayNight,
      params,
    );
    if (prior > best) best = prior;

    if (detection.frpMw !== null) {
      if (!Number.isFinite(detection.frpMw) || detection.frpMw < 0) {
        throw new RangeError(
          `FRP must be a non-negative number of MW, got ${String(detection.frpMw)} on ${detection.detectionUid}`,
        );
      }
      if (maxFrpMw === null || detection.frpMw > maxFrpMw) maxFrpMw = detection.frpMw;
    }

    if (detection.dayNight === 'N') anyNight = true;
    if (detection.dayNight !== 'D' || detection.confidence !== 'low') {
      allDaytimeLowConfidence = false;
    }

    const nadir = params.nadirPixelBySource[detection.source];
    if (nadir !== null) {
      scanningCount += 1;
      if (!atSwathEdge(detection, nadir, params)) allScanningAtSwathEdge = false;
    }
  }

  const overpasses = overpassKeys.size;
  const persist = Math.min(overpasses - 1, params.persistOverpassCap) / params.persistOverpassCap;

  return {
    features: {
      best,
      persist,
      multisrc: platforms.size >= 2 ? 1 : 0,
      night: anyNight ? 1 : 0,
      coherence: hasCoherentOverpass(byOverpass, params) ? 1 : 0,
      frp: frpFeature(maxFrpMw, params),
      fwi: context.fwiAtLeastHigh === true ? 1 : 0,
      agri: context.arableMajorityUnderHull === true ? 1 : 0,
      // "All" over an empty set is vacuously true, and here that would mean a GEO-only
      // event is "far-swath-only evidence" — a statement about a swath it does not have.
      // The quantifier ranges over scanning detections and needs at least one.
      edge: scanningCount > 0 && allScanningAtSwathEdge ? 1 : 0,
      glint: allDaytimeLowConfidence ? 1 : 0,
    },
    retained,
    waterGuarded,
    overpasses,
    platforms: platforms.size,
    maxFrpMw,
  };
}

/**
 * The unit of evidence §3.3 argues for: one platform × one pass for a scanning source, and
 * a fixed slice of wall time for a geostationary one.
 *
 * The GEO key is shared by **all** GEO sources rather than kept per source. SEVIRI and FCI
 * watch the same fire from the same side of the same sky, so two frames of the same three
 * hours are one observation of one atmosphere, not two independent revisits — the same
 * correlated-evidence argument the E-accumulator makes when it caps the GEO daily weight
 * across GEO sources rather than per source. Buckets are anchored on the epoch, which is
 * UTC midnight, and 3 h divides the day evenly, so a bucket never straddles a UTC day.
 */
function overpassKey(detection: ScoringDetection, acqTs: EpochMs, params: ScoreParams): string {
  const nadir = params.nadirPixelBySource[detection.source];
  if (nadir === null) {
    const bucket = Math.floor(acqTs / (params.geoOverpassEquivalentHours * HOUR_MS));
    return `geo|${String(bucket)}`;
  }
  const platform = params.platformBySource[detection.source];
  const utcDay = Math.floor(acqTs / DAY_MS);
  const phase =
    detection.dayNight === 'N' ? 'night' : detection.dayNight === 'D' ? 'day' : 'unknown';
  return `${platform}|${String(utcDay)}|${phase}`;
}

/** x9's per-row test: `scan·track` above `edgeAreaMultiple` × the instrument's nadir area. */
function atSwathEdge(
  detection: ScoringDetection,
  nadir: { readonly scanKm: number; readonly trackKm: number },
  params: ScoreParams,
): boolean {
  // A row with no footprint is the documented nadir case (Appendix A rule 4), not an
  // unknown: it resolves to the nadir pixel, which is never above its own multiple. So a
  // footprint-less event is not "swath edge", which is the conservative reading of a
  // negative feature — a penalty is only applied on evidence that it is due.
  if (detection.scanKm === null || detection.trackKm === null) return false;
  if (
    !Number.isFinite(detection.scanKm) ||
    !Number.isFinite(detection.trackKm) ||
    detection.scanKm <= 0 ||
    detection.trackKm <= 0
  ) {
    throw new RangeError(
      `footprint must be positive km, got ${String(detection.scanKm)}×${String(detection.trackKm)} on ${detection.detectionUid}`,
    );
  }
  const area = detection.scanKm * detection.trackKm;
  const nadirArea = nadir.scanKm * nadir.trackKm;
  return area > params.edgeAreaMultiple * nadirArea;
}

/**
 * x5: is there one overpass containing `coherenceMinDetections` detections that are
 * *mutually* within `coherenceRadiusKm`?
 *
 * Mutually, not transitively: three pixels in a 2 km chain are each 750 m from a
 * neighbour, and that is a line of noise, not the contiguous patch §3.4 describes. The
 * search is therefore for a clique, over the members of a single overpass — which is also
 * why it stays cheap, one pass over the AOI being tens of pixels at most.
 *
 * Positions are deduplicated inside the overpass first. The feature is about spatial
 * extent — a burning patch several pixels across — and one pixel reported three times is
 * one place, not three. For a polar pass the distinction rarely arises, because an
 * instrument images each piece of ground once; for a geostationary source it always does,
 * since the 3 h overpass-equivalent contains up to eighteen frames of the *same* grid, and
 * without the dedup every repeated GEO pixel would score as a coherent cluster of itself.
 * That would also make worked example 5 — a single GEO pixel in four consecutive slots —
 * coherent, which is plainly not what the table means by a GEO-only cluster scoring 0.33.
 *
 * Distances go through the same planar metric and the same quantised `withinKm` the
 * identity engine uses, so "exactly 750 m" is inside the radius (Appendix A rule 3) rather
 * than decided by the last bits of a square root.
 */
function hasCoherentOverpass(
  byOverpass: ReadonlyMap<string, readonly ScoringDetection[]>,
  params: ScoreParams,
): boolean {
  const needed = params.coherenceMinDetections;
  for (const group of byOverpass.values()) {
    if (group.length < needed) continue;
    const seen = new Set<string>();
    const points: Coordinate[] = [];
    for (const detection of group) {
      const key = `${detection.latCanonical},${detection.lonCanonical}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(coordinateOf(detection));
    }
    if (points.length < needed) continue;
    if (hasMutualClique(points, needed, params)) return true;
  }
  return false;
}

function coordinateOf(detection: ScoringDetection): Coordinate {
  return {
    lat: parseCanonicalDegrees(detection.latCanonical, `${detection.detectionUid} lat`),
    lon: parseCanonicalDegrees(detection.lonCanonical, `${detection.detectionUid} lon`),
  };
}

/** Depth-first search for `size` points that are pairwise within the coherence radius. */
function hasMutualClique(
  points: readonly Coordinate[],
  size: number,
  params: ScoreParams,
): boolean {
  const close: boolean[][] = points.map((a) =>
    points.map((b) =>
      withinKm(distanceKm(a, b, params.metric), params.coherenceRadiusKm, params.metric),
    ),
  );
  const chosen: number[] = [];
  const extend = (from: number): boolean => {
    if (chosen.length === size) return true;
    for (let i = from; i < points.length; i += 1) {
      if (chosen.every((j) => close[i]?.[j] === true)) {
        chosen.push(i);
        if (extend(i + 1)) return true;
        chosen.pop();
      }
    }
    return false;
  };
  return extend(0);
}

/**
 * x6, verbatim: `min(ln(1 + FRP_max) / ln(1 + 100), 1)`. An event where nothing reported
 * FRP scores 0 — the same value a reported 0 MW gives, because `ln(1)/ln(101) = 0`, and
 * that coincidence is harmless: neither is evidence of radiative power.
 */
function frpFeature(maxFrpMw: number | null, params: ScoreParams): number {
  if (maxFrpMw === null) return 0;
  return Math.min(Math.log(1 + maxFrpMw) / Math.log(1 + params.frpSaturationMw), 1);
}
