import {
  SCORE_BUCKET_FLOOR,
  SOURCE_IDS,
  SOURCE_REGISTRY,
  scoreBucket,
} from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../clustering/clustering-params.js';
import { CONFIG_VERSION_RE, configDigest } from '../config/versioned-config.js';
import {
  DETECTION_CLASSES,
  PLATFORM_GROUPS,
  SCORE_PARAMS,
  detectionPrior,
  quantizeScore,
} from './score-params.js';

const PARAMS = SCORE_PARAMS.values;

describe('score_params_v0 identity', () => {
  it('carries a version the replay fixtures can validate', () => {
    expect(SCORE_PARAMS.name).toBe('score_params');
    expect(SCORE_PARAMS.version).toMatch(CONFIG_VERSION_RE);
    // v0, not v1: 11 §3.5 calls these weights hand-set, and §3.7 fits them later. The
    // digit is the claim that nothing here has met a label yet.
    expect(SCORE_PARAMS.version).toBe('score_params_v0');
  });

  it('pins the digest, because a refit that forgot to bump the version is invisible', () => {
    expect(SCORE_PARAMS.digest).toBe(configDigest(PARAMS));
    expect(SCORE_PARAMS.digest).toBe('e920a2f5');
  });

  it('is frozen, so scoring cannot tune the weights it is being judged by', () => {
    expect(Object.isFrozen(SCORE_PARAMS)).toBe(true);
    expect(Object.isFrozen(PARAMS)).toBe(true);
  });
});

describe('the transcribed numbers of 11 §3.5', () => {
  it('holds the intercept and the ten weights exactly as the review states them', () => {
    expect(PARAMS.intercept).toBe(-2.0);
    expect(PARAMS.weights).toEqual({
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
    });
  });

  it('keeps the three penalties negative and the seven corroborations positive', () => {
    // The review writes the last three terms as subtractions; they are stored signed so
    // the fold is uniform. If a future fit flips one (§3.7 warns that a sign flip is a
    // finding, not a result), this test is where it has to be argued.
    expect(PARAMS.weights.agri).toBeLessThan(0);
    expect(PARAMS.weights.edge).toBeLessThan(0);
    expect(PARAMS.weights.glint).toBeLessThan(0);
    for (const key of [
      'best',
      'persist',
      'multisrc',
      'night',
      'coherence',
      'frp',
      'fwi',
    ] as const) {
      expect(PARAMS.weights[key]).toBeGreaterThan(0);
    }
  });

  it('lets a single nominal daytime pixel fall short of Likely on its own', () => {
    // z = −2.0 + 1.8·0.65 = −0.83 → σ = 0.303862, which is what the intercept is for.
    const z = PARAMS.intercept + PARAMS.weights.best * 0.65;
    expect(z).toBeCloseTo(-0.83, 12);
    expect(quantizeScore(1 / (1 + Math.exp(-z)))).toBeLessThan(PARAMS.bucketFloor.likely);
  });
});

describe('the c_i table of 11 §3.2', () => {
  it('prices every class for both halves of the day', () => {
    expect(Object.keys(PARAMS.detectionPriors).slice().sort()).toEqual(
      DETECTION_CLASSES.slice().sort(),
    );
    for (const detectionClass of DETECTION_CLASSES) {
      const prior = PARAMS.detectionPriors[detectionClass];
      expect(prior.day).toBeGreaterThan(0);
      expect(prior.day).toBeLessThan(1);
      expect(prior.night).toBeLessThan(1);
      // Night is never cheaper than day: the night side has no solar false-positive
      // channels, which is the whole reason x_night carries a positive weight.
      expect(prior.night).toBeGreaterThanOrEqual(prior.day);
    }
  });

  it('orders each instrument high > nominal > low', () => {
    expect(PARAMS.detectionPriors.viirs_high.day).toBeGreaterThan(
      PARAMS.detectionPriors.viirs_nominal.day,
    );
    expect(PARAMS.detectionPriors.viirs_nominal.day).toBeGreaterThan(
      PARAMS.detectionPriors.viirs_low.day,
    );
    expect(PARAMS.detectionPriors.modis_high.day).toBeGreaterThan(
      PARAMS.detectionPriors.modis_nominal.day,
    );
    expect(PARAMS.detectionPriors.modis_nominal.day).toBeGreaterThan(
      PARAMS.detectionPriors.modis_low.day,
    );
  });

  it('prices a VIIRS pixel above the MODIS pixel of the same confidence', () => {
    // 375 m against 1 km: the same word means a better-resolved fire on VIIRS.
    expect(PARAMS.detectionPriors.viirs_high.day).toBeGreaterThan(
      PARAMS.detectionPriors.modis_high.day,
    );
    expect(PARAMS.detectionPriors.viirs_nominal.day).toBeGreaterThan(
      PARAMS.detectionPriors.modis_nominal.day,
    );
  });
});

describe('the per-source reading rules', () => {
  it('covers every registry id, including retired ones a replay still needs', () => {
    expect(Object.keys(PARAMS.classBySource).slice().sort()).toEqual(SOURCE_IDS.slice().sort());
    expect(Object.keys(PARAMS.platformBySource).slice().sort()).toEqual(SOURCE_IDS.slice().sort());
    expect(Object.keys(PARAMS.nadirPixelBySource).slice().sort()).toEqual(
      SOURCE_IDS.slice().sort(),
    );
  });

  it('names only platforms from the declared list', () => {
    for (const id of SOURCE_IDS) {
      expect(PLATFORM_GROUPS).toContain(PARAMS.platformBySource[id]);
    }
  });

  it('gives exactly the geostationary sources no nadir pixel — they have no swath edge', () => {
    const withoutPixel = SOURCE_IDS.filter((id) => PARAMS.nadirPixelBySource[id] === null);
    const geostationary = SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].productTier === 'GEO');
    expect(withoutPixel).toEqual(geostationary);
    expect(geostationary).toEqual(['lsasaf:seviri:frp-pixel', 'lsasaf:fci:frp-pixel']);
  });

  it('publishes no confidence spread where §3.2 publishes none', () => {
    // SLSTR and the two GEO products have one row each in the table, qualified
    // "(quality ok)". A spread across l/n/h here would be a number nobody wrote down.
    for (const id of [
      'eumetsat:slstr:frp',
      'lsasaf:seviri:frp-pixel',
      'lsasaf:fci:frp-pixel',
    ] as const) {
      const classes = PARAMS.classBySource[id];
      expect(classes.low).toBe(classes.nominal);
      expect(classes.nominal).toBe(classes.high);
    }
  });

  it('keeps the VIIRS and MODIS spreads that §3.2 does publish', () => {
    const viirs = PARAMS.classBySource['firms:viirs:snpp'];
    expect([viirs.low, viirs.nominal, viirs.high]).toEqual([
      'viirs_low',
      'viirs_nominal',
      'viirs_high',
    ]);
    const modis = PARAMS.classBySource['firms:modis'];
    expect([modis.low, modis.nominal, modis.high]).toEqual([
      'modis_low',
      'modis_nominal',
      'modis_high',
    ]);
  });
});

describe('feature shape parameters', () => {
  it('states x2, x5 and x6 as 11 §3.4 writes them', () => {
    expect(PARAMS.persistOverpassCap).toBe(3);
    expect(PARAMS.geoOverpassEquivalentHours).toBe(3);
    expect(PARAMS.coherenceRadiusKm).toBe(0.75);
    expect(PARAMS.coherenceMinDetections).toBe(3);
    expect(PARAMS.frpSaturationMw).toBe(100);
    expect(PARAMS.edgeAreaMultiple).toBe(2);
    expect(PARAMS.polarOverpassGrouping).toBe('platform_utc_day_phase');
  });

  it('divides the day evenly into GEO overpass-equivalents, so no bucket straddles midnight', () => {
    expect(24 % PARAMS.geoOverpassEquivalentHours).toBe(0);
  });
});

describe('bucket floors', () => {
  it('holds 11 §3.9 and ADR-002 D6 — 0.75 Confirmed, 0.45 Likely', () => {
    expect(PARAMS.bucketFloor).toEqual({ confirmed: 0.75, likely: 0.45 });
  });

  it('cannot drift from the contracts copy the API renders', () => {
    // Two definitions of "Confirmed" is one too many. §3.9 puts the thresholds in
    // versioned config; the contracts constant is what the client reads. They are pinned
    // equal here rather than one importing the other, so that moving a floor forces a
    // score version bump instead of silently re-labelling last season's archive.
    expect(PARAMS.bucketFloor.confirmed).toBe(SCORE_BUCKET_FLOOR.confirmed);
    expect(PARAMS.bucketFloor.likely).toBe(SCORE_BUCKET_FLOOR.likely);
    expect(scoreBucket(PARAMS.bucketFloor.confirmed)).toBe('confirmed');
    expect(scoreBucket(PARAMS.bucketFloor.likely)).toBe('likely');
  });

  it('orders the floors, leaving a non-empty Likely band', () => {
    expect(PARAMS.bucketFloor.confirmed).toBeGreaterThan(PARAMS.bucketFloor.likely);
    expect(PARAMS.bucketFloor.likely).toBeGreaterThan(0);
    expect(PARAMS.bucketFloor.confirmed).toBeLessThan(1);
  });
});

describe('the copied planar metric', () => {
  it('is identical to clustering_params_v1, which x5 must measure 750 m with', () => {
    // Copied rather than imported (see the module header): importing would make this
    // config's digest a function of the clustering version. This test is the price of the
    // copy — the two cannot drift, they can only be changed together and deliberately.
    expect(PARAMS.metric).toEqual(CLUSTERING_PARAMS.values.metric);
  });
});

describe('quantizeScore', () => {
  it('produces the same double a fixture writes as a decimal literal', () => {
    // The reason for ×1e6/1e6 rather than /1e-6×1e-6: the latter returns
    // 0.018890999999999998 for worked example 1, which no reviewer would recognize as
    // the 0.018891 in expected.json.
    expect(quantizeScore(0.01889099736842105)).toBe(0.018891);
    expect(quantizeScore(0.8130573860319537)).toBe(0.813057);
    expect(quantizeScore(0.9109262579884938)).toBe(0.910926);
  });

  it('makes a bucket floor reachable rather than a state the arithmetic steps over', () => {
    expect(quantizeScore(0.7499999999)).toBe(0.75);
    expect(quantizeScore(0.4500000001)).toBe(0.45);
    expect(quantizeScore(0)).toBe(0);
    expect(quantizeScore(1)).toBe(1);
  });

  it('refuses a non-finite score rather than bucketing NaN', () => {
    expect(() => quantizeScore(Number.NaN)).toThrow(RangeError);
    expect(() => quantizeScore(Number.POSITIVE_INFINITY)).toThrow(/must be finite/);
  });
});

describe('detectionPrior', () => {
  it('reads the night column only for a row that said night', () => {
    expect(detectionPrior('firms:viirs:snpp', 'high', 'N')).toBe(0.95);
    expect(detectionPrior('firms:viirs:snpp', 'high', 'D')).toBe(0.9);
  });

  it('reads a row with no day_night on the lower, daytime column', () => {
    // Every GEO row is `day_night: null` by construction. Paying it the night prior would
    // be paying for a claim about solar geometry that the product never made.
    expect(detectionPrior('lsasaf:seviri:frp-pixel', 'nominal', null)).toBe(
      PARAMS.detectionPriors.geo_frp_pixel.day,
    );
    expect(detectionPrior('lsasaf:seviri:frp-pixel', 'nominal', null)).toBeLessThan(
      PARAMS.detectionPriors.geo_frp_pixel.night,
    );
  });

  it('gives the three §3.5 worked-example priors their stated values', () => {
    // The examples quote x_best = .25 / .65 / .95 / .55; these are the table rows they
    // come from, which is what makes the worked examples reproducible at all.
    expect(detectionPrior('firms:viirs:snpp', 'low', 'D')).toBe(0.25);
    expect(detectionPrior('firms:viirs:snpp', 'nominal', 'D')).toBe(0.65);
    expect(detectionPrior('firms:viirs:snpp', 'high', 'N')).toBe(0.95);
    expect(detectionPrior('lsasaf:seviri:frp-pixel', 'nominal', null)).toBe(0.55);
  });
});
