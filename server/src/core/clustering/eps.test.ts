import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from './clustering-params.js';
import { epsKmFor, epsRuleFor, isAttachOnly } from './eps.js';

const MODIS = 'firms:modis';
const VIIRS = 'firms:viirs:snpp';
const SEVIRI = 'lsasaf:seviri:frp-pixel';

/** A footprint the row actually carried. */
const measured = { scanKm: 1.0, trackKm: 1.0 };

describe('epsKmFor — fixed rules', () => {
  it('ignores the footprint for a fixed-ε source', () => {
    // A VIIRS pixel is 375 m everywhere in the swath, so a per-row footprint would be
    // noise dressed as precision.
    expect(epsKmFor(VIIRS, { scanKm: 0.375, trackKm: 0.375 }).km).toBe(1.25);
    expect(epsKmFor(VIIRS, { scanKm: null, trackKm: null }).km).toBe(1.25);
    expect(epsKmFor(VIIRS, { scanKm: null, trackKm: null }).footprintDefaulted).toBe(false);
  });

  it('throws for a source with no configured ε rather than returning NaN', () => {
    // Every comparison against NaN is false, so a NaN ε does not fail — it silently stops
    // a source from ever clustering. Loud is the only safe direction here.
    expect(() => epsRuleFor('not-a-source' as never)).toThrow(RangeError);
  });
});

describe('epsKmFor — MODIS footprint rule (ADR-002 D2)', () => {
  it('is max(3 km, 1.5·√(scan·track))', () => {
    // Nadir: 1.5·√2 ≈ 2.12 km, so the 3 km floor wins.
    expect(epsKmFor(MODIS, { scanKm: 1.0, trackKm: 2.0 }).km).toBe(3);
    // Edge of swath: 1.5·√(4.8·2) ≈ 4.65 km, so the measured footprint wins.
    expect(epsKmFor(MODIS, { scanKm: 4.8, trackKm: 2.0 }).km).toBeCloseTo(4.6476, 4);
  });

  it('never returns less than the floor', () => {
    expect(epsKmFor(MODIS, { scanKm: 0.1, trackKm: 0.1 }).km).toBe(3);
  });
});

describe('Appendix A rule 4 — the nadir footprint substitution', () => {
  // "MODIS ε with a missing, zero, non-finite or ≤ 0 footprint substitutes the nadir
  // 1.0 km scan × 2.0 km track *before* ε is computed, so ε = 3 km, sets
  // footprint_defaulted = true, and is counted per batch. ε is never NaN."

  it('substitutes for a missing footprint', () => {
    const eps = epsKmFor(MODIS, { scanKm: null, trackKm: null });
    expect(eps.km).toBe(3);
    expect(eps.footprintDefaulted).toBe(true);
  });

  it('substitutes for a zero footprint', () => {
    // Without the rule: 1.5·√0 = 0, the floor lifts it back to 3 km, and nothing is
    // flagged — the same ε for the wrong reason, and a source silently dropping its
    // footprint column would never be noticed.
    const eps = epsKmFor(MODIS, { scanKm: 0, trackKm: 0 });
    expect(eps.km).toBe(3);
    expect(eps.footprintDefaulted).toBe(true);
  });

  it('substitutes for a negative footprint', () => {
    const eps = epsKmFor(MODIS, { scanKm: -1, trackKm: 2 });
    expect(eps.km).toBe(3);
    expect(eps.footprintDefaulted).toBe(true);
  });

  it('substitutes for a non-finite footprint, so ε is never NaN', () => {
    // This is the case the rule exists for: √(NaN·2) is NaN, max(3, NaN) is NaN, and every
    // subsequent `distance <= ε` is false. The detection would join nothing, seed its own
    // event, and the map would sprout a phantom fire per broken row.
    for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const eps = epsKmFor(MODIS, { scanKm: broken, trackKm: 2 });
      expect(Number.isFinite(eps.km)).toBe(true);
      expect(eps.km).toBe(3);
      expect(eps.footprintDefaulted).toBe(true);
    }
  });

  it('substitutes the whole pair, not the broken axis — the case that would flip', () => {
    // `scan = null, track = 8`. Defaulting only the broken axis gives
    // 1.5·√(1.0·8.0) ≈ 4.24 km; substituting the pair, as the appendix states, gives the
    // pinned 3 km. Everything else in this file passes under either reading; this is the
    // one assertion that separates them, and a 1.24 km difference in ε is the difference
    // between one event and two on a windy day.
    const eps = epsKmFor(MODIS, { scanKm: null, trackKm: 8 });
    expect(eps.km).toBe(3);
    expect(eps.footprintDefaulted).toBe(true);
  });

  it('does not flag a row whose footprint was usable', () => {
    expect(epsKmFor(MODIS, measured).footprintDefaulted).toBe(false);
  });
});

describe('isAttachOnly', () => {
  it('reads the frozen registry rather than matching a source-id string', () => {
    // Adding a geostationary source must be one row in the registry, not an edit inside
    // the clustering loop that somebody has to remember.
    expect(isAttachOnly(SEVIRI)).toBe(true);
    expect(isAttachOnly('lsasaf:fci:frp-pixel')).toBe(true);
    expect(isAttachOnly(VIIRS)).toBe(false);
    expect(isAttachOnly(MODIS)).toBe(false);
    expect(isAttachOnly('eumetsat:slstr:frp')).toBe(false);
  });
});

describe('a non-default parameter set', () => {
  it('is honoured, because a replay runs on the version it was recorded under', () => {
    const retuned = {
      ...CLUSTERING_PARAMS.values,
      epsBySource: {
        ...CLUSTERING_PARAMS.values.epsBySource,
        [VIIRS]: { kind: 'fixed', km: 1.0 } as const,
      },
    };
    expect(epsKmFor(VIIRS, measured, retuned).km).toBe(1.0);
    expect(epsKmFor(VIIRS, measured).km).toBe(1.25);
  });
});
