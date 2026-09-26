/**
 * `score_params_v0` — every number the confidence score is allowed to consult
 * (ADR-002 D6 "Score"; 11 §3.2, §3.4, §3.5, §3.9).
 *
 * Versioned data rather than constants, for the reason D5 gives generally and one that is
 * specific to this table: **none of these weights is fitted**. 11 §3.5 calls them a
 * "hand-set logistic" and §3.7 replaces them with an L2-fitted set on the backfill without
 * changing the shape of the formula. A refit that edited the numbers in place would
 * silently change what every archived score meant; a refit that lands
 * `score_params_v1` leaves last season's scores readable as what they were. That is also
 * why the version below is `_v0` and not `_v1`: the digit is the honest statement that
 * nothing here has met a label yet.
 *
 * ## What is a citation and what is a choice
 *
 * The intercept, the ten weights, the `c_i` table and the bucket floors are transcribed
 * from 11 §3.2/§3.5/§3.9 and nothing else. Everything below them —
 * {@link ScoreParams.platformBySource}, {@link ScoreParams.nadirPixelBySource},
 * {@link ScoreParams.polarOverpassGrouping} — exists because §3.4 states a feature in
 * terms the repo has no single field for ("one platform × one pass", "2× nadir area") and
 * something has to say, in data, how the archive's rows are read into those terms. Each
 * one carries the document its value comes from. Nothing here is a number someone liked.
 *
 * ## The metric is copied, not imported
 *
 * x5 measures 750 m, so this module needs a metric — and it carries its own copy of
 * `clustering_params_v1`'s rather than importing the object. Importing it would make this
 * config's digest a function of *that* config's version: a retune of ε would move the
 * score digest without anyone bumping the score version, which is the exact failure the
 * digest exists to catch. `score-params.test.ts` pins the copy equal to the original, the
 * same way `clustering-params.test.ts` pins the nadir substitution equal to
 * `NADIR_SCAN_KM`/`NADIR_TRACK_KM`, so the two cannot drift instead.
 */

import type { SourceId } from '@fire-watch/contracts';

import type { PlanarMetric } from '../clustering/clustering-params.js';
import { defineConfig, type VersionedConfig } from '../config/versioned-config.js';
import type { DetectionConfidence } from '../ports/detection-store.js';

/**
 * The rows of 11 §3.2's table. A detection is mapped onto one of these before it is worth
 * anything to the score, because the sources speak three confidence dialects and the
 * formula speaks one.
 */
export const DETECTION_CLASSES = [
  'viirs_high',
  'viirs_nominal',
  'viirs_low',
  'modis_high',
  'modis_nominal',
  'modis_low',
  'geo_frp_pixel',
  'slstr_frp',
] as const;
export type DetectionClass = (typeof DETECTION_CLASSES)[number];

/**
 * `c_i` = P(this single detection alone is a real vegetation fire), by half of the day.
 * A pseudo-probability and a deliberately conservative prior (§3.2), not a published
 * commission rate — the validation campaigns behind the 1.2 % figure did not contain the
 * false-positive classes that dominate a consumer product's error budget.
 */
export interface DetectionPrior {
  readonly day: number;
  readonly night: number;
}

/**
 * The platforms x3 counts. "Distinct platforms", not distinct sources: the registry id is
 * the *product* we poll, and two of them are each a pair of satellites.
 *
 * `terra_aqua` and `sentinel3` are the honest consequence of the frozen registry
 * (GLOSSARY §1a): `firms:modis` is one id for Terra **and** Aqua, `eumetsat:slstr:frp` is
 * one id for S3A **and** S3B, and §1a rule 2 forbids recovering the platform from the CSV
 * `satellite` column. So an event seen by Terra and then by Aqua counts as one platform
 * here. That under-counts corroboration and therefore *lowers* the score, which is the
 * direction to be wrong in for a number the UI renders as confidence.
 */
export const PLATFORM_GROUPS = [
  'snpp',
  'noaa20',
  'noaa21',
  'terra_aqua',
  'sentinel3',
  'msg',
  'mtg',
] as const;
export type PlatformGroup = (typeof PLATFORM_GROUPS)[number];

/** The nominal nadir pixel of a scanning instrument — the reference x9's "2× nadir area" is a multiple of. */
export interface NadirPixel {
  readonly scanKm: number;
  readonly trackKm: number;
}

/**
 * The weights of 11 §3.5, **with their signs as the review states them**. `agri`, `edge`
 * and `glint` are negative numbers here rather than positive numbers subtracted at the
 * call site, so that the fold in `score.ts` is `z = intercept + Σ wᵢ·xᵢ` for every term
 * and no reader has to remember which three are special.
 */
export interface FeatureWeights {
  readonly best: number;
  readonly persist: number;
  readonly multisrc: number;
  readonly night: number;
  readonly coherence: number;
  readonly frp: number;
  readonly fwi: number;
  readonly agri: number;
  readonly edge: number;
  readonly glint: number;
}

/** The §3.9 floors. Closed at the bottom: exactly 0.75 is Confirmed, exactly 0.45 is Likely. */
export interface BucketFloor {
  readonly confirmed: number;
  readonly likely: number;
}

export interface ScoreParams {
  /** §3.5's `−2.0`. */
  readonly intercept: number;
  readonly weights: FeatureWeights;

  /**
   * §3.2's table. Every class appears for both halves of the day, including the classes
   * whose night row is rare in the product (`viirs_low`): a replay must be able to score a
   * row the live path would find surprising, not crash on it.
   */
  readonly detectionPriors: Readonly<Record<DetectionClass, DetectionPrior>>;

  /**
   * Registry id + normalized confidence → §3.2 class. A `Record` over `SourceId` on
   * purpose: adding a source without deciding what its detections are worth is a type
   * error, not a runtime surprise where a new instrument silently scores as VIIRS.
   *
   * The three confidence entries are identical for SLSTR and for the two GEO sources
   * because **§3.2 publishes no confidence split for them** — one row each, qualified
   * "(quality ok)". The decoders do normalize a `low`/`nominal`/`high` for those rows, and
   * inventing a spread from it would be exactly the fabricated number this table must not
   * contain. The quality qualifier is a product-level statement and is enforced upstream,
   * where the QC flags are.
   */
  readonly classBySource: Readonly<
    Record<SourceId, Readonly<Record<DetectionConfidence, DetectionClass>>>
  >;

  /** Which platform each registry id speaks for (x3). */
  readonly platformBySource: Readonly<Record<SourceId, PlatformGroup>>;

  /**
   * How the detections of a polar source are grouped into "one overpass" for x2 and x5.
   *
   * `platform_utc_day_phase` = one platform, one UTC day, one half of the day. §3.4 says
   * "one platform × one pass" and the archive has no pass id: FIRMS rows carry an
   * `acq_time` per granule, so grouping on the timestamp would count the two or three
   * granules of a single pass over Bulgaria as two or three overpasses and inflate x2 —
   * the feature that is supposed to mean *persistence across revisits*.
   *
   * The grouping can under-count instead: a satellite whose consecutive orbits both clip
   * the AOI, or whose night passes straddle 00:00 UTC, contributes one overpass where it
   * saw the fire twice. That is the direction to be wrong in, and it matches what
   * DATA-SOURCES §A1 records about the constellation — "~4–6 usable overpasses/day
   * combined (day + night)" across the polled products, which is about one usable pass per
   * platform per half-day, not several.
   *
   * The value is data rather than a code path so that the digest covers the *rule*: a
   * later version that learns a real pass id is a version bump, visible in every report.
   */
  readonly polarOverpassGrouping: 'platform_utc_day_phase';

  /**
   * §3.4's GEO clause: "GEO counts as max 1 overpass-equivalent per 3 h". Hours rather
   * than a slot count because SEVIRI repeats every 15 min and FCI every 10 min
   * (DATA-SOURCES §A4) — the cap is about elapsed time, not about how many frames a
   * particular instrument fits into it.
   */
  readonly geoOverpassEquivalentHours: number;

  /** x2's `min(n − 1, 3) / 3` — the count at which persistence saturates. */
  readonly persistOverpassCap: number;

  /** x5: "≥ 3 detections mutually within 750 m within a single overpass". */
  readonly coherenceRadiusKm: number;
  readonly coherenceMinDetections: number;

  /** x6 saturates at 100 MW, i.e. `min(ln(1 + FRP) / ln(1 + 100), 1)`. */
  readonly frpSaturationMw: number;

  /**
   * The nominal nadir pixel per source, for x9's "pixels with area > 2× nadir area
   * (`scan·track` vs nominal)". `null` for the geostationary sources: a GEO instrument has
   * one fixed viewing geometry over Bulgaria and no swath edge to be at, so "far-swath-only
   * evidence" is not a statement that can be true of it.
   *
   * These are the instruments' published nadir footprints — VIIRS 375 m (DATA-SOURCES §A1,
   * GLOSSARY §1a), MODIS 1 km (03-geodata §"eps MODIS": "1 km pixel, up to ~4 km at swath
   * edge"), SLSTR 1 km thermal (DATA-SOURCES §A3) — and deliberately **not**
   * `NADIR_SCAN_KM`/`NADIR_TRACK_KM` (1 × 2 km). Those are the ε substitution for a row
   * that arrived without a footprint, documented there as "deliberately the coarse
   * choice"; reusing them here would put a MODIS-shaped reference under a 375 m pixel and
   * make x9 unreachable for VIIRS.
   */
  readonly nadirPixelBySource: Readonly<Record<SourceId, NadirPixel | null>>;

  /** x9's multiple: strictly greater than this many nadir areas is "swath edge". */
  readonly edgeAreaMultiple: number;

  /** §3.9's presentation floors, pinned equal to the contracts' copy by test. */
  readonly bucketFloor: BucketFloor;

  /**
   * The quantum the emitted score is rounded to, before it is bucketed and before it is
   * written anywhere.
   *
   * Two reasons, in the order they matter. First, `Math.exp` is *implementation-
   * approximated* in ECMAScript exactly as `Math.sin`/`Math.atan2` are — the argument
   * `geometry.ts` makes about the haversine applies to the logistic — so two V8 builds may
   * legally return scores differing in the last bits, and CI-2 diffs replay output byte for
   * byte. Second, a bucket boundary must be reachable: without rounding, "exactly 0.45" is
   * a state no event ever occupies and §3.9's closed-at-the-bottom rule is untestable.
   *
   * 1e-6 is far below any difference the buckets or the alert gate can see, and
   * `quantizeScore` rounds by `×1e6 / 1e6` rather than `/q × q` so the result is the same
   * double a fixture's decimal literal parses to — the same form `formatCanonicalDegrees`
   * uses for the 5 dp coordinate grid.
   */
  readonly scoreQuantum: number;

  /** A copy of `clustering_params_v1.metric`; `score-params.test.ts` pins it equal. */
  readonly metric: PlanarMetric;
}

export const SCORE_PARAMS: VersionedConfig<ScoreParams> = defineConfig(
  'score_params',
  'score_params_v0',
  {
    // 11 §3.5, transcribed. The intercept is what makes a lone nominal daytime pixel land
    // below the Likely floor: with x_best = 0.65 and nothing else, z = −0.83.
    intercept: -2.0,
    weights: {
      best: 1.8,
      persist: 1.0,
      multisrc: 0.8,
      night: 0.7,
      coherence: 0.6,
      frp: 0.5,
      fwi: 0.3,
      agri: -1.0,
      edge: -0.6,
      glint: -0.8,
    },
    detectionPriors: {
      // Day / night, 11 §3.2. Night is never lower than day in this table: the night side
      // has no solar false-positive channels.
      viirs_high: { day: 0.9, night: 0.95 },
      viirs_nominal: { day: 0.65, night: 0.8 },
      viirs_low: { day: 0.25, night: 0.4 },
      modis_high: { day: 0.85, night: 0.9 },
      modis_nominal: { day: 0.55, night: 0.7 },
      modis_low: { day: 0.25, night: 0.35 },
      geo_frp_pixel: { day: 0.55, night: 0.65 },
      slstr_frp: { day: 0.6, night: 0.7 },
    },
    classBySource: {
      // VIIRS ships the l/n/h the table is keyed by directly.
      'firms:viirs:snpp': { low: 'viirs_low', nominal: 'viirs_nominal', high: 'viirs_high' },
      'firms:viirs:noaa20': { low: 'viirs_low', nominal: 'viirs_nominal', high: 'viirs_high' },
      'firms:viirs:noaa21': { low: 'viirs_low', nominal: 'viirs_nominal', high: 'viirs_high' },
      // MODIS 0–100 is binned <30 / 30–79 / ≥80 by `firms-csv.ts`, which is FIRMS's own
      // convention and the binning §3.2 says to adopt — so the parser's three values land
      // on the table's three MODIS rows with no second threshold defined here.
      'firms:modis': { low: 'modis_low', nominal: 'modis_nominal', high: 'modis_high' },
      'eumetsat:slstr:frp': { low: 'slstr_frp', nominal: 'slstr_frp', high: 'slstr_frp' },
      'lsasaf:seviri:frp-pixel': {
        low: 'geo_frp_pixel',
        nominal: 'geo_frp_pixel',
        high: 'geo_frp_pixel',
      },
      'lsasaf:fci:frp-pixel': {
        low: 'geo_frp_pixel',
        nominal: 'geo_frp_pixel',
        high: 'geo_frp_pixel',
      },
    },
    platformBySource: {
      'firms:viirs:snpp': 'snpp',
      'firms:viirs:noaa20': 'noaa20',
      'firms:viirs:noaa21': 'noaa21',
      'firms:modis': 'terra_aqua',
      'eumetsat:slstr:frp': 'sentinel3',
      // SEVIRI is on MSG and FCI is on MTG — two satellites, and §3.4's platform list
      // names MTG explicitly. They are the most correlated pair in the table (near-identical
      // viewing geometry over Bulgaria), which is an argument for refitting x3's weight in
      // v1, not for hiding one of them behind the other here.
      'lsasaf:seviri:frp-pixel': 'msg',
      'lsasaf:fci:frp-pixel': 'mtg',
    },
    polarOverpassGrouping: 'platform_utc_day_phase',
    geoOverpassEquivalentHours: 3,
    persistOverpassCap: 3,
    coherenceRadiusKm: 0.75,
    coherenceMinDetections: 3,
    frpSaturationMw: 100,
    nadirPixelBySource: {
      'firms:viirs:snpp': { scanKm: 0.375, trackKm: 0.375 },
      'firms:viirs:noaa20': { scanKm: 0.375, trackKm: 0.375 },
      'firms:viirs:noaa21': { scanKm: 0.375, trackKm: 0.375 },
      'firms:modis': { scanKm: 1.0, trackKm: 1.0 },
      'eumetsat:slstr:frp': { scanKm: 1.0, trackKm: 1.0 },
      'lsasaf:seviri:frp-pixel': null,
      'lsasaf:fci:frp-pixel': null,
    },
    edgeAreaMultiple: 2,
    bucketFloor: { confirmed: 0.75, likely: 0.45 },
    scoreQuantum: 1e-6,
    metric: {
      referenceLatDeg: 42.7,
      kmPerDegreeLat: 111.085,
      kmPerDegreeLonAtReference: 81.936,
      kmPerDegreeLonPerDegreeLat: -1.3146,
      quantumKm: 1e-6,
    },
  } as const,
);

/**
 * Rounds a score to the parameter quantum. `×scale / scale` rather than `/q × q`: the
 * latter leaves `0.018890999999999998` where the fixture writes `0.018891`, and a replay
 * that cannot state its own output as a decimal literal is a replay nobody can review.
 */
export function quantizeScore(value: number, params: ScoreParams = SCORE_PARAMS.values): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`score must be finite, got ${String(value)}`);
  }
  const scale = 1 / params.scoreQuantum;
  return Math.round(value * scale) / scale;
}

/** The `c_i` of one detection: its §3.2 class, read on the half of the day it arrived in. */
export function detectionPrior(
  source: SourceId,
  confidence: DetectionConfidence,
  dayNight: 'D' | 'N' | null,
  params: ScoreParams = SCORE_PARAMS.values,
): number {
  const byConfidence = params.classBySource[source];
  const detectionClass = byConfidence[confidence];
  const prior = params.detectionPriors[detectionClass];
  // A row with no `day_night` — every GEO row, by construction (`detection-records.ts`
  // refuses to invent one from the slot) — is read on the **day** column, the lower of the
  // two. The night column is a claim about solar geometry, and a row that never stated one
  // must not be paid for it.
  return dayNight === 'N' ? prior.night : prior.day;
}
