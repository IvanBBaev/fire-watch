import { SOURCE_IDS, SOURCE_REGISTRY } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { configDigest } from '../config/versioned-config.js';
import { NADIR_SCAN_KM, NADIR_TRACK_KM } from '../ingest/detection-validation.js';
import { CLUSTERING_PARAMS, activeWindowMs, tLinkMs } from './clustering-params.js';

describe('clustering_params_v1', () => {
  it('is versioned data with a digest over its values', () => {
    expect(CLUSTERING_PARAMS.name).toBe('clustering_params');
    expect(CLUSTERING_PARAMS.version).toBe('clustering_params_v1');
    expect(CLUSTERING_PARAMS.digest).toBe(configDigest(CLUSTERING_PARAMS.values));
  });

  it('gives every registered source an ε, including the retired one', () => {
    // A source without an ε would either crash mid-batch or, worse, silently borrow a
    // neighbour's radius. MODIS is retired but still reachable through backfill and
    // fixture replay, so "retired" is not a reason to leave it out.
    for (const source of SOURCE_IDS) {
      expect(CLUSTERING_PARAMS.values.epsBySource[source]).toBeDefined();
    }
  });

  it('keeps every ε inside the range ADR-002 D2 states for its source', () => {
    const eps = CLUSTERING_PARAMS.values.epsBySource;
    for (const source of [
      'firms:viirs:snpp',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
    ] as const) {
      const rule = eps[source];
      expect(rule.kind).toBe('fixed');
      if (rule.kind === 'fixed') {
        expect(rule.km).toBeGreaterThanOrEqual(1.0);
        expect(rule.km).toBeLessThanOrEqual(1.5);
      }
    }
    for (const source of ['lsasaf:seviri:frp-pixel', 'lsasaf:fci:frp-pixel'] as const) {
      const rule = eps[source];
      expect(rule.kind).toBe('fixed');
      if (rule.kind === 'fixed') {
        expect(rule.km).toBeGreaterThanOrEqual(5);
        expect(rule.km).toBeLessThanOrEqual(6);
      }
    }
    const modis = eps['firms:modis'];
    expect(modis.kind).toBe('footprint');
    if (modis.kind === 'footprint') {
      expect(modis.floorKm).toBe(3);
      expect(modis.factor).toBe(1.5);
    }
  });

  it('holds the same nadir footprint the ingest validator uses', () => {
    // Appendix A rule 4 is one substitution stated in two places: ingest fills a missing
    // footprint for its own validation, clustering substitutes it before ε. If the two
    // drift, the same row is validated against one pixel size and clustered at another —
    // and the drift would be invisible, because both halves keep working.
    const modis = CLUSTERING_PARAMS.values.epsBySource['firms:modis'];
    expect(modis.kind).toBe('footprint');
    if (modis.kind === 'footprint') {
      expect(modis.defaultScanKm).toBe(NADIR_SCAN_KM);
      expect(modis.defaultTrackKm).toBe(NADIR_TRACK_KM);
    }
  });

  it('gives the coarse sources a wider ε than any fine one', () => {
    // Not decoration: a GEO pixel is ~5 km across, so an ε narrower than a fine source's
    // would mean a corroborating GEO detection could not reach the cluster it corroborates.
    const eps = CLUSTERING_PARAMS.values.epsBySource;
    const fixedKm = (source: keyof typeof eps): number => {
      const rule = eps[source];
      return rule.kind === 'fixed' ? rule.km : rule.floorKm;
    };
    const coarse = SOURCE_IDS.filter((source) => SOURCE_REGISTRY[source].attachOnly);
    const fine = SOURCE_IDS.filter((source) => !SOURCE_REGISTRY[source].attachOnly);
    for (const geo of coarse) {
      for (const other of fine) {
        expect(fixedKm(geo)).toBeGreaterThan(fixedKm(other));
      }
    }
  });

  it('states T_LINK inside the 36–60 h band and an active window of 72 h', () => {
    expect(CLUSTERING_PARAMS.values.tLinkHours).toBeGreaterThanOrEqual(36);
    expect(CLUSTERING_PARAMS.values.tLinkHours).toBeLessThanOrEqual(60);
    expect(tLinkMs()).toBe(48 * 3_600_000);
    expect(activeWindowMs()).toBe(72 * 3_600_000);
  });

  it('keeps T_LINK inside the active window', () => {
    // The other way round would be a rule that can never fire: a cluster evicted at 72 h
    // cannot be a candidate for a detection 80 h after its last one, whatever T_LINK says.
    expect(tLinkMs()).toBeLessThanOrEqual(activeWindowMs());
  });

  it('states the three fuel bands with the middle one as the unclassified default', () => {
    const params = CLUSTERING_PARAMS.values;
    expect(params.reignitionWindowDays).toEqual({ grass: 7, mixed: 14, forest: 21 });
    expect(params.unclassifiedFuelBand).toBe('mixed');
    expect(params.reignitionEpsMultiple).toBe(2);
  });

  it('states the review hull diameter inside the 15–25 km band D4 settled on', () => {
    // Not a split threshold — D4 forbids automatic splits. It is the width at which "this
    // may be two fires" stops being a suspicion the engine keeps to itself, and both
    // directions cost something real: too low buries a reviewer under complexes that are
    // genuinely one fire, too high publishes an over-merge nobody looked at.
    const params = CLUSTERING_PARAMS.values;
    expect(params.reviewHullDiameterKm).toBeGreaterThanOrEqual(15);
    expect(params.reviewHullDiameterKm).toBeLessThanOrEqual(25);
    expect(params.reviewHullDiameterKm).toBe(20);
  });

  it('keeps the review diameter well above any single ε', () => {
    // A hull can only reach this width through a chain of ε-hops. If one hop could reach
    // it, the flag would fire on ordinary two-detection events and mean nothing.
    const params = CLUSTERING_PARAMS.values;
    const widestEpsKm = Math.max(
      ...SOURCE_IDS.map((source) => {
        const rule = params.epsBySource[source];
        return rule.kind === 'fixed' ? rule.km : rule.floorKm;
      }),
    );
    expect(params.reviewHullDiameterKm).toBeGreaterThan(2 * widestEpsKm);
  });

  it('measures on a metric whose quantum is far below coordinate resolution', () => {
    // A 5-decimal degree is ~1.1 m of latitude. A quantum at or above that would merge two
    // genuinely different distances; one far below only absorbs floating-point noise.
    const metric = CLUSTERING_PARAMS.values.metric;
    expect(metric.quantumKm).toBe(1e-6);
    const fiveDecimalDegreesKm = 0.0011;
    expect(metric.quantumKm).toBeLessThan(fiveDecimalDegreesKm / 100);
  });

  it('is frozen, so a caller cannot retune it in place', () => {
    expect(Object.isFrozen(CLUSTERING_PARAMS)).toBe(true);
    expect(Object.isFrozen(CLUSTERING_PARAMS.values)).toBe(true);
  });
});
