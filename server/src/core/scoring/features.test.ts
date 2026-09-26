import { describe, expect, it } from 'vitest';

import {
  computeFeatures,
  waterGuardDrops,
  type ScoringContext,
  type ScoringDetection,
} from './features.js';
import { SCORE_PARAMS } from './score-params.js';

const PARAMS = SCORE_PARAMS.values;

/** Nothing stated: both un-derivable features are `null`, the honest default of a caller with no FWI and no land cover. */
const NOTHING_STATED: ScoringContext = { fwiAtLeastHigh: null, arableMajorityUnderHull: null };

let uid = 0;

function detection(overrides: Partial<ScoringDetection> = {}): ScoringDetection {
  uid += 1;
  return {
    detectionUid: `d${String(uid)}`,
    source: 'firms:viirs:snpp',
    acqTsIso: '2025-08-01T11:00:00Z',
    latCanonical: '42.70000',
    lonCanonical: '23.30000',
    confidence: 'nominal',
    dayNight: 'D',
    frpMw: null,
    scanKm: null,
    trackKm: null,
    overOrAdjacentToWater: null,
    ...overrides,
  };
}

function features(
  detections: readonly ScoringDetection[],
  context: ScoringContext = NOTHING_STATED,
) {
  return computeFeatures(detections, context).features;
}

describe('preconditions', () => {
  it('refuses an event with no detections rather than scoring an empty sum', () => {
    expect(() => computeFeatures([], NOTHING_STATED)).toThrow(RangeError);
  });

  it('refuses an event the water guard would empty — such an event cannot exist', () => {
    // The guard runs pre-clustering (§3.6), so every one of these rows would have been
    // dropped before an event was ever formed. Reaching this state means the caller has
    // mixed up its inputs, and a score of "the empty vector" would hide that.
    const guarded = detection({
      confidence: 'low',
      dayNight: 'D',
      overOrAdjacentToWater: true,
    });
    expect(() => computeFeatures([guarded], NOTHING_STATED)).toThrow(/water\/glint guard/);
  });

  it('rejects a negative or non-finite FRP instead of feeding it to a logarithm', () => {
    expect(() => features([detection({ frpMw: -1 })])).toThrow(/non-negative/);
    expect(() => features([detection({ frpMw: Number.NaN })])).toThrow(RangeError);
  });

  it('rejects a non-positive footprint instead of comparing a nonsense area', () => {
    expect(() => features([detection({ scanKm: 0, trackKm: 1 })])).toThrow(/positive km/);
  });
});

describe('§3.6 override 2 — the water/glint guard', () => {
  it('drops only daytime low-confidence detections that were checked and found over water', () => {
    expect(
      waterGuardDrops(detection({ confidence: 'low', dayNight: 'D', overOrAdjacentToWater: true })),
    ).toBe(true);
    // Night is not glint.
    expect(
      waterGuardDrops(detection({ confidence: 'low', dayNight: 'N', overOrAdjacentToWater: true })),
    ).toBe(false);
    // A nominal daytime pixel over water is a fire on a riverbank, not sun on a ripple.
    expect(
      waterGuardDrops(
        detection({ confidence: 'nominal', dayNight: 'D', overOrAdjacentToWater: true }),
      ),
    ).toBe(false);
    // Never asked: the guard cannot fire on a question nobody put to the land cover.
    expect(
      waterGuardDrops(detection({ confidence: 'low', dayNight: 'D', overOrAdjacentToWater: null })),
    ).toBe(false);
  });

  it('removes the guarded rows from every feature, and reports them separately', () => {
    const kept = detection({ confidence: 'high', dayNight: 'N' });
    const dropped = detection({
      confidence: 'low',
      dayNight: 'D',
      overOrAdjacentToWater: true,
      frpMw: 90,
    });
    const derivation = computeFeatures([kept, dropped], NOTHING_STATED);
    expect(derivation.retained).toEqual([kept]);
    expect(derivation.waterGuarded).toEqual([dropped]);
    // The dropped row's 90 MW is not the event's FRP: it is not the event's anything.
    expect(derivation.maxFrpMw).toBeNull();
    expect(derivation.features.best).toBe(0.95);
  });
});

describe('x1 x_best — the strongest single detection', () => {
  it('takes the maximum c_i, not the mean and not the last', () => {
    const f = features([
      detection({ confidence: 'low', dayNight: 'D' }),
      detection({ confidence: 'high', dayNight: 'N' }),
      detection({ confidence: 'nominal', dayNight: 'D' }),
    ]);
    expect(f.best).toBe(0.95);
  });

  it('prices a GEO-only event on the day column, since GEO rows carry no day_night', () => {
    const f = features([detection({ source: 'lsasaf:seviri:frp-pixel', dayNight: null })]);
    expect(f.best).toBe(0.55);
  });
});

describe('x2 x_persist — distinct overpasses, not distinct detections', () => {
  it('scores 0 for a single overpass however many pixels it contains', () => {
    // Five pixels of one pass are one observation of one fire: §3.3's whole argument.
    const f = features([
      detection(),
      detection({ latCanonical: '42.70100' }),
      detection({ latCanonical: '42.70200' }),
      detection({ latCanonical: '42.70300' }),
      detection({ latCanonical: '42.70400' }),
    ]);
    expect(f.persist).toBe(0);
  });

  it('does not split one pass into several overpasses on the granule timestamp', () => {
    // Two FIRMS rows of the same S-NPP pass, minutes apart. Grouping on acq_time would
    // call this persistence; it is one look.
    const f = features([
      detection({ acqTsIso: '2025-08-01T11:00:00Z' }),
      detection({ acqTsIso: '2025-08-01T11:06:00Z' }),
    ]);
    expect(f.persist).toBe(0);
  });

  it('counts the two halves of a day as two overpasses of the same platform', () => {
    const f = features([
      detection({ acqTsIso: '2025-08-01T11:00:00Z', dayNight: 'D' }),
      detection({ acqTsIso: '2025-08-01T23:40:00Z', dayNight: 'N' }),
    ]);
    // min(2 − 1, 3) / 3 = 1/3. The review's table writes this as ".33"; the engine keeps
    // the exact third, because rounding a feature would move z by 0.003 for no reason.
    expect(f.persist).toBe(1 / 3);
  });

  it('counts two platforms in the same half-day as two overpasses', () => {
    const f = features([
      detection({ source: 'firms:viirs:snpp' }),
      detection({ source: 'firms:viirs:noaa20', acqTsIso: '2025-08-01T12:30:00Z' }),
    ]);
    expect(f.persist).toBe(1 / 3);
  });

  it('saturates at the cap: a fourth extra overpass adds nothing', () => {
    const four = [
      detection({ source: 'firms:viirs:snpp', acqTsIso: '2025-08-01T11:00:00Z', dayNight: 'D' }),
      detection({ source: 'firms:viirs:snpp', acqTsIso: '2025-08-01T23:40:00Z', dayNight: 'N' }),
      detection({ source: 'firms:viirs:noaa20', acqTsIso: '2025-08-01T12:30:00Z', dayNight: 'D' }),
      detection({ source: 'firms:viirs:noaa20', acqTsIso: '2025-08-02T01:10:00Z', dayNight: 'N' }),
    ];
    expect(features(four).persist).toBe(1);
    const five = [
      ...four,
      detection({ source: 'firms:modis', acqTsIso: '2025-08-02T09:20:00Z', dayNight: 'D' }),
    ];
    expect(features(five).persist).toBe(1);
    expect(computeFeatures(five, NOTHING_STATED).overpasses).toBe(5);
  });

  it('gives a whole burst of GEO slots inside 3 h a single overpass-equivalent', () => {
    // §3.4: "GEO counts as max 1 overpass-equivalent per 3 h". Four consecutive 10-minute
    // FCI slots are forty minutes of the same geometry, not four revisits.
    const slots = ['12:00', '12:10', '12:20', '12:30'].map((hm) =>
      detection({
        source: 'lsasaf:fci:frp-pixel',
        dayNight: null,
        acqTsIso: `2025-08-01T${hm}:00Z`,
      }),
    );
    const derivation = computeFeatures(slots, NOTHING_STATED);
    expect(derivation.overpasses).toBe(1);
    expect(derivation.features.persist).toBe(0);
  });

  it('counts GEO slots more than 3 h apart as separate overpass-equivalents', () => {
    const f = features([
      detection({
        source: 'lsasaf:fci:frp-pixel',
        dayNight: null,
        acqTsIso: '2025-08-01T02:50:00Z',
      }),
      detection({
        source: 'lsasaf:fci:frp-pixel',
        dayNight: null,
        acqTsIso: '2025-08-01T06:10:00Z',
      }),
    ]);
    expect(f.persist).toBe(1 / 3);
  });

  it('shares one 3 h budget across SEVIRI and FCI, which watch from the same place', () => {
    // The E-accumulator caps GEO weight per UTC day across GEO sources rather than per
    // source, for the same reason: two frames of the same three hours from the same
    // geostationary arc are one observation, not two.
    const derivation = computeFeatures(
      [
        detection({
          source: 'lsasaf:seviri:frp-pixel',
          dayNight: null,
          acqTsIso: '2025-08-01T12:00:00Z',
        }),
        detection({
          source: 'lsasaf:fci:frp-pixel',
          dayNight: null,
          acqTsIso: '2025-08-01T12:10:00Z',
        }),
      ],
      NOTHING_STATED,
    );
    expect(derivation.overpasses).toBe(1);
    // …and yet they are two platforms, which x3 does count.
    expect(derivation.platforms).toBe(2);
  });

  it('anchors the 3 h buckets on UTC midnight, so no bucket straddles a day', () => {
    const f = features([
      detection({
        source: 'lsasaf:fci:frp-pixel',
        dayNight: null,
        acqTsIso: '2025-08-01T23:50:00Z',
      }),
      detection({
        source: 'lsasaf:fci:frp-pixel',
        dayNight: null,
        acqTsIso: '2025-08-02T00:10:00Z',
      }),
    ]);
    // Twenty minutes apart, but on opposite sides of 00:00 — two equivalents, because the
    // buckets are fixed slices of UTC rather than a window since the first detection.
    expect(f.persist).toBe(1 / 3);
  });
});

describe('x3 x_multisrc — distinct platforms', () => {
  it('needs two platforms, not two detections', () => {
    expect(features([detection(), detection({ latCanonical: '42.70100' })]).multisrc).toBe(0);
    expect(
      features([detection({ source: 'firms:viirs:snpp' }), detection({ source: 'firms:modis' })])
        .multisrc,
    ).toBe(1);
  });

  it('counts Terra and Aqua as one platform, because the frozen registry cannot tell them apart', () => {
    // `firms:modis` is a single registry id for both satellites and GLOSSARY §1a rule 2
    // forbids recovering the platform from the CSV `satellite` column. This under-counts
    // corroboration, which lowers the score — the safe direction.
    const f = features([
      detection({ source: 'firms:modis', acqTsIso: '2025-08-01T09:00:00Z' }),
      detection({ source: 'firms:modis', acqTsIso: '2025-08-01T21:00:00Z', dayNight: 'N' }),
    ]);
    expect(f.multisrc).toBe(0);
    // The same pair is still two overpasses: persistence and platform diversity are
    // different questions.
    expect(f.persist).toBe(1 / 3);
  });

  it('counts MSG and MTG as two platforms, as §3.4 names MTG in its list', () => {
    expect(
      features([
        detection({ source: 'lsasaf:seviri:frp-pixel', dayNight: null }),
        detection({ source: 'lsasaf:fci:frp-pixel', dayNight: null }),
      ]).multisrc,
    ).toBe(1);
  });
});

describe('x4 x_night — any night detection', () => {
  it('is an any-quantifier: one night pixel is enough', () => {
    expect(features([detection({ dayNight: 'D' }), detection({ dayNight: 'N' })]).night).toBe(1);
    expect(features([detection({ dayNight: 'D' })]).night).toBe(0);
  });

  it('is not set by a row with no day_night', () => {
    expect(features([detection({ source: 'lsasaf:fci:frp-pixel', dayNight: null })]).night).toBe(0);
  });
});

describe('x5 x_coherence — three mutually close detections in one overpass', () => {
  const near = (lat: string, lon: string, over: Partial<ScoringDetection> = {}) =>
    detection({ latCanonical: lat, lonCanonical: lon, ...over });

  it('fires for three pixels that are pairwise within 750 m in the same pass', () => {
    // Pairwise 0.444 km, 0.466 km, 0.466 km on the planar metric.
    const f = features([
      near('42.70000', '23.30000'),
      near('42.70400', '23.30000'),
      near('42.70200', '23.30500'),
    ]);
    expect(f.coherence).toBe(1);
  });

  it('needs three, not two', () => {
    expect(features([near('42.70000', '23.30000'), near('42.70400', '23.30000')]).coherence).toBe(
      0,
    );
  });

  it('requires mutual proximity, not a chain', () => {
    // 0.667 km, 0.667 km — and 1.333 km end to end. Three pixels strung along a line are
    // a scan artefact, not the contiguous patch the feature is about.
    const f = features([
      near('42.70000', '23.30000'),
      near('42.70600', '23.30000'),
      near('42.71200', '23.30000'),
    ]);
    expect(f.coherence).toBe(0);
  });

  it('finds the clique among detections that are not adjacent in the input order', () => {
    const f = features([
      near('42.70000', '23.30000'),
      near('42.75000', '23.30000'),
      near('42.70400', '23.30000'),
      near('42.76000', '23.30000'),
      near('42.70200', '23.30500'),
    ]);
    expect(f.coherence).toBe(1);
  });

  it('does not assemble a clique out of separate overpasses', () => {
    // Three coincident pixels seen on three different passes is persistence (x2), and
    // paying for it again as spatial coherence would double-count the same evidence —
    // exactly the correlation §3.3 warns about.
    const f = features([
      near('42.70000', '23.30000', { acqTsIso: '2025-08-01T11:00:00Z', dayNight: 'D' }),
      near('42.70040', '23.30000', { acqTsIso: '2025-08-01T23:00:00Z', dayNight: 'N' }),
      near('42.70080', '23.30000', {
        acqTsIso: '2025-08-02T11:00:00Z',
        dayNight: 'D',
        source: 'firms:viirs:noaa20',
      }),
    ]);
    expect(f.coherence).toBe(0);
    expect(f.persist).toBe(2 / 3);
  });

  it('counts places, not repeats: one pixel seen four times is not a cluster', () => {
    // Four consecutive SEVIRI slots of the same grid cell fall in one 3 h
    // overpass-equivalent. Without deduplicating the position they would be four mutually
    // co-located detections and x5 would fire on a single pixel — and worked example 5,
    // a GEO-only cluster, would score as coherent, which the table plainly does not mean.
    const slots = ['12:00', '12:10', '12:20', '12:30'].map((hm) =>
      detection({
        source: 'lsasaf:seviri:frp-pixel',
        dayNight: null,
        acqTsIso: `2025-08-01T${hm}:00Z`,
      }),
    );
    expect(features(slots).coherence).toBe(0);
  });

  it('still fires for three distinct GEO cells inside one overpass-equivalent', () => {
    const cells = ['23.30000', '23.30300', '23.30600'].map((lon) =>
      detection({
        source: 'lsasaf:seviri:frp-pixel',
        dayNight: null,
        lonCanonical: lon,
        acqTsIso: '2025-08-01T12:00:00Z',
      }),
    );
    expect(features(cells).coherence).toBe(1);
  });

  it('treats the radius as inclusive on the quantised grid', () => {
    // 0.00675° of latitude is 0.749824 km — inside; 0.00676° is 0.750935 km — outside.
    // A millimetre either side of the bound, decided by the same `withinKm` the identity
    // engine uses rather than by a raw float comparison.
    const inside = features([
      near('42.70000', '23.30000'),
      near('42.70675', '23.30000'),
      near('42.70337', '23.30000'),
    ]);
    expect(inside.coherence).toBe(1);
    const outside = features([
      near('42.70000', '23.30000'),
      near('42.70676', '23.30000'),
      near('42.70338', '23.30000'),
    ]);
    expect(outside.coherence).toBe(0);
  });
});

describe('x6 x_frp — log-scaled radiative power', () => {
  it('is min(ln(1 + FRP_max) / ln(101), 1)', () => {
    expect(features([detection({ frpMw: 25 })]).frp).toBe(Math.log(26) / Math.log(101));
    expect(features([detection({ frpMw: 40 })]).frp).toBe(Math.log(41) / Math.log(101));
  });

  it('saturates at 100 MW and never exceeds 1', () => {
    expect(features([detection({ frpMw: 100 })]).frp).toBe(1);
    expect(features([detection({ frpMw: 5000 })]).frp).toBe(1);
  });

  it('takes the maximum, not the last or the sum', () => {
    const f = features([
      detection({ frpMw: 4 }),
      detection({ frpMw: 100 }),
      detection({ frpMw: 9 }),
    ]);
    expect(f.frp).toBe(1);
    expect(
      computeFeatures([detection({ frpMw: 4 }), detection({ frpMw: 9 })], NOTHING_STATED).maxFrpMw,
    ).toBe(9);
  });

  it('scores an unreported FRP and a reported zero the same, and reports them differently', () => {
    // ln(1)/ln(101) = 0, so the feature cannot tell them apart — and it does not need to:
    // neither is evidence of radiative power. The derivation keeps the distinction that
    // pitfall 9 insists on, `null` ≠ 0.
    expect(features([detection({ frpMw: null })]).frp).toBe(0);
    expect(features([detection({ frpMw: 0 })]).frp).toBe(0);
    expect(computeFeatures([detection({ frpMw: null })], NOTHING_STATED).maxFrpMw).toBeNull();
    expect(computeFeatures([detection({ frpMw: 0 })], NOTHING_STATED).maxFrpMw).toBe(0);
  });
});

describe('x7 x_fwi and x8 x_agri — the two stated inputs', () => {
  it('scores an unstated FWI as 0, which withholds credit', () => {
    expect(
      features([detection()], { fwiAtLeastHigh: null, arableMajorityUnderHull: null }).fwi,
    ).toBe(0);
    expect(
      features([detection()], { fwiAtLeastHigh: false, arableMajorityUnderHull: null }).fwi,
    ).toBe(0);
    expect(
      features([detection()], { fwiAtLeastHigh: true, arableMajorityUnderHull: null }).fwi,
    ).toBe(1);
  });

  it('scores an unstated land cover as 0, which withholds a penalty', () => {
    // The wrong direction, and deliberately visible: until D10 lands there is no land
    // cover to classify with, and inventing one would be worse than scoring high.
    expect(
      features([detection()], { fwiAtLeastHigh: null, arableMajorityUnderHull: null }).agri,
    ).toBe(0);
    expect(
      features([detection()], { fwiAtLeastHigh: null, arableMajorityUnderHull: false }).agri,
    ).toBe(0);
    expect(
      features([detection()], { fwiAtLeastHigh: null, arableMajorityUnderHull: true }).agri,
    ).toBe(1);
  });
});

describe('x9 x_edge — all scanning pixels at the swath edge', () => {
  const bigViirs = { scanKm: 0.6, trackKm: 0.6 }; // 0.36 km² > 2 × 0.140625 km²
  const nadirViirs = { scanKm: 0.375, trackKm: 0.375 };

  it('fires only when every scanning detection is off-nadir', () => {
    expect(features([detection(bigViirs), detection(bigViirs)]).edge).toBe(1);
    // One well-resolved pixel is enough to make "far-swath-only evidence" untrue.
    expect(features([detection(bigViirs), detection(nadirViirs)]).edge).toBe(0);
  });

  it('measures against the instrument nadir, not the coarse ε substitution', () => {
    // A 0.6 × 0.6 km pixel is off-nadir for VIIRS (nadir 0.375 × 0.375) and well within
    // nadir for MODIS (1 × 1). Using the 1 × 2 km ε fallback for both would make x9
    // unreachable for VIIRS, the instrument that produces most of the archive.
    expect(features([detection({ source: 'firms:viirs:snpp', ...bigViirs })]).edge).toBe(1);
    expect(features([detection({ source: 'firms:modis', ...bigViirs })]).edge).toBe(0);
  });

  it('treats a missing footprint as the nadir pixel, so it is not an edge', () => {
    expect(features([detection({ scanKm: null, trackKm: null })]).edge).toBe(0);
  });

  it('is never true of a GEO-only event, which has no swath to be at the edge of', () => {
    // "All" over an empty set is vacuously true; here that would penalize a geostationary
    // event for a viewing geometry it does not have, so the quantifier needs a witness.
    const f = features([
      detection({ source: 'lsasaf:fci:frp-pixel', dayNight: null, scanKm: 5, trackKm: 5 }),
    ]);
    expect(f.edge).toBe(0);
  });

  it('ignores GEO rows when judging the scanning ones', () => {
    const f = features([
      detection({ source: 'firms:viirs:snpp', ...bigViirs }),
      detection({ source: 'lsasaf:fci:frp-pixel', dayNight: null, scanKm: 5, trackKm: 5 }),
    ]);
    expect(f.edge).toBe(1);
  });

  it('is strictly greater than the multiple, not greater-or-equal', () => {
    const exactly = { scanKm: 0.28125, trackKm: 1 }; // exactly 2 × nadir area
    expect(features([detection(exactly)]).edge).toBe(0);
    expect(features([detection({ scanKm: 0.2813, trackKm: 1 })]).edge).toBe(1);
  });
});

describe('x10 x_glint — all detections daytime and low confidence', () => {
  it('needs every detection to be both', () => {
    const low = { confidence: 'low', dayNight: 'D' } as const;
    expect(features([detection(low), detection(low)]).glint).toBe(1);
    expect(
      features([detection(low), detection({ confidence: 'nominal', dayNight: 'D' })]).glint,
    ).toBe(0);
    expect(features([detection(low), detection({ confidence: 'low', dayNight: 'N' })]).glint).toBe(
      0,
    );
  });

  it('is not set by a GEO-only event, whose rows are neither day nor night', () => {
    // Consistent with worked example 5, whose GEO-only cluster is "daytime" in prose but
    // carries no day_night in the archive and takes no glint penalty in the table.
    expect(
      features([
        detection({ source: 'lsasaf:seviri:frp-pixel', dayNight: null, confidence: 'low' }),
      ]).glint,
    ).toBe(0);
  });
});

describe('determinism', () => {
  it('does not depend on the order the detections arrive in', () => {
    const detections = [
      detection({ confidence: 'high', dayNight: 'N', frpMw: 30, acqTsIso: '2025-08-01T23:00:00Z' }),
      detection({ source: 'firms:modis', confidence: 'nominal', frpMw: 12 }),
      detection({ latCanonical: '42.70400' }),
      detection({ latCanonical: '42.70200', lonCanonical: '23.30500' }),
    ];
    const forwards = features(detections);
    const backwards = features(detections.slice().reverse());
    expect(backwards).toEqual(forwards);
  });

  it('bounds every feature to [0,1]', () => {
    const f = features(
      [
        detection({ confidence: 'high', dayNight: 'N', frpMw: 900, scanKm: 0.6, trackKm: 0.6 }),
        detection({ source: 'firms:modis', acqTsIso: '2025-08-03T09:00:00Z' }),
      ],
      { fwiAtLeastHigh: true, arableMajorityUnderHull: true },
    );
    for (const value of Object.values(f)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the coherence radius and the cap it reads from the params, not from literals', () => {
    expect(PARAMS.coherenceRadiusKm).toBe(0.75);
    expect(PARAMS.persistOverpassCap).toBe(3);
  });
});
