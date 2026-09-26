import { describe, expect, it } from 'vitest';

import { ALERT_GATING } from '../config/alert-gating.js';
import { LIFECYCLE_PARAMS } from '../config/lifecycle-params.js';
import { POLLING_BBOX, alertableEnvelope, assertBoundingBox } from '../config/polling-bbox.js';
import { CONFIG_VERSION_RE, configDigest } from '../config/versioned-config.js';
import { ALERTING_OUTCOMES, QA_METRICS, QUANTILE_METHODS } from './qa-metrics-params.js';

const PARAMS = QA_METRICS.values;

describe('qa_metrics_v1 identity', () => {
  it('carries a version the CP1 report can cite', () => {
    expect(QA_METRICS.name).toBe('qa_metrics');
    expect(QA_METRICS.version).toMatch(CONFIG_VERSION_RE);
  });

  it('pins the digest, because a threshold edited after the season is invisible', () => {
    expect(QA_METRICS.digest).toBe(configDigest(PARAMS));
    expect(QA_METRICS.digest).toBe('43e53e7c');
  });

  it('is frozen, so a report cannot tune the numbers it is being graded by', () => {
    expect(Object.isFrozen(QA_METRICS)).toBe(true);
    expect(Object.isFrozen(PARAMS)).toBe(true);
  });
});

describe('perimeter populations', () => {
  it('reports the two populations GLOSSARY §8 names, gating on the larger one', () => {
    expect(PARAMS.perimeters.strata.map((stratum) => stratum.minAreaHa)).toEqual([50, 10]);
    expect(PARAMS.perimeters.strata.map((stratum) => stratum.targetRate)).toEqual([0.95, 0.85]);
    expect(PARAMS.perimeters.strata.map((stratum) => stratum.gating)).toEqual([true, false]);
  });

  it('nests the populations, so the informative one is a superset', () => {
    const [gating, informative] = PARAMS.perimeters.strata;
    expect(gating?.minAreaHa).toBeGreaterThan(informative?.minAreaHa ?? 0);
    expect(gating?.targetRate).toBeGreaterThan(informative?.targetRate ?? 0);
  });

  it('keeps GATES §4 CP1 minimum-n and the 2 km buffer', () => {
    expect(PARAMS.perimeters.minimumN).toBe(20);
    expect(PARAMS.perimeters.bufferKm).toBe(2);
  });
});

describe('synthetic zone lattice', () => {
  it('covers the alertable area — a fire in a zone-less cell would score as un-alerted', () => {
    const bounds = PARAMS.lattice.bounds;
    assertBoundingBox(bounds);
    const alertable = alertableEnvelope();
    expect(bounds.west).toBeLessThanOrEqual(alertable.west);
    expect(bounds.south).toBeLessThanOrEqual(alertable.south);
    expect(bounds.east).toBeGreaterThanOrEqual(alertable.east);
    expect(bounds.north).toBeGreaterThanOrEqual(alertable.north);
  });

  it('stays strictly inside the polled box — an unpolled zone can never be alerted', () => {
    const bounds = PARAMS.lattice.bounds;
    const polled = POLLING_BBOX.values;
    expect(bounds.west).toBeGreaterThan(polled.west);
    expect(bounds.south).toBeGreaterThan(polled.south);
    expect(bounds.east).toBeLessThan(polled.east);
    expect(bounds.north).toBeLessThan(polled.north);
  });

  it('pins the bounds to exactly representable degrees, so no engine rounds them apart', () => {
    for (const edge of Object.values(PARAMS.lattice.bounds)) {
      expect(Number.isInteger(edge * 2)).toBe(true);
    }
  });

  it('uses the 10 km pitch GATES §4 CP1 states', () => {
    expect(PARAMS.lattice.pitchKm).toBe(10);
  });
});

describe('quantile rule', () => {
  it('pins one convention, so "p95" is not an implementation detail', () => {
    expect(QUANTILE_METHODS).toEqual(['nearest_rank_inclusive']);
    expect(PARAMS.quantile.method).toBe('nearest_rank_inclusive');
    expect(PARAMS.quantile.p50).toBe(0.5);
    expect(PARAMS.quantile.p95).toBe(0.95);
  });
});

describe('PLB budgets', () => {
  it('matches GLOSSARY §8.1 stage by stage', () => {
    expect(PARAMS.plb.ingestAllowanceMs).toBe(120_000);
    expect(PARAMS.plb.ingestedToEventUpdatedMs).toBe(60_000);
    expect(PARAMS.plb.eventUpdatedToDecidedMs).toBe(10_000);
    expect(PARAMS.plb.decidedToPushAckMs).toBe(60_000);
    expect(PARAMS.plb.decidedToEmailAckMs).toBe(300_000);
    expect(PARAMS.plb.eventUpdatedToBroadcastMs).toBe(2_000);
    expect(PARAMS.plb.controllableTotalMs).toBe(900_000);
  });

  it('grades the CP1 shadow chain against the same 15 minutes as the full one', () => {
    // GATES §4 CP1 states ≤ 15 min p95 over ingest + clustering alone, which is a subset
    // of the stages the steady total covers — so the shadow bar is the stricter one.
    expect(PARAMS.plb.shadowTotalMs).toBe(PARAMS.plb.controllableTotalMs);
  });

  it('leaves every stage budget inside the total it is part of', () => {
    expect(PARAMS.plb.ingestedToEventUpdatedMs).toBeLessThan(PARAMS.plb.shadowTotalMs);
    expect(PARAMS.plb.eventUpdatedToDecidedMs).toBeLessThan(PARAMS.plb.controllableTotalMs);
    expect(PARAMS.plb.decidedToEmailAckMs).toBeLessThan(PARAMS.plb.controllableTotalMs);
  });
});

describe('what is deliberately read from elsewhere', () => {
  it('states no FER threshold of its own — lifecycle_params_v1 owns them', () => {
    expect(Object.keys(PARAMS.fer)).toEqual(['excludeUnobservableClosures']);
    expect(LIFECYCLE_PARAMS.values.ferMaxRate).toBe(0.05);
    expect(LIFECYCLE_PARAMS.values.ferMaxRateLarge).toBe(0.1);
    expect(LIFECYCLE_PARAMS.values.ferWindowHours).toBe(72);
  });

  it('states no suppression window of its own — alert_gating_v1 owns it', () => {
    expect(Object.keys(PARAMS.dar)).toEqual(['shadowMaxRate', 'steadyMaxRate']);
    expect(ALERT_GATING.values.suppressionWindowMs).toBe(6 * 60 * 60 * 1000);
  });
});

describe('FLR and DAR rules', () => {
  it('keeps GLOSSARY §8 FLR: three reversals in 48 h', () => {
    expect(PARAMS.flr.windowHours).toBe(48);
    expect(PARAMS.flr.minReversals).toBe(3);
  });

  it('keeps GLOSSARY §8 DAR: 5% in shadow tightening to 1% in steady state', () => {
    expect(PARAMS.dar.shadowMaxRate).toBe(0.05);
    expect(PARAMS.dar.steadyMaxRate).toBe(0.01);
    expect(PARAMS.dar.steadyMaxRate).toBeLessThan(PARAMS.dar.shadowMaxRate);
  });
});

describe('alerting outcomes', () => {
  it('counts a deferred alert as an alert, so shadow-PCR does not measure the hour', () => {
    // A `defer` decided the alert and advanced the state; it went to the next digest
    // instead of piercing quiet hours. Excluding it would make shadow-PCR a function of
    // what time of night the fire started.
    expect(ALERTING_OUTCOMES).toEqual(['send', 'defer']);
    expect(ALERTING_OUTCOMES).not.toContain('seed');
    expect(ALERTING_OUTCOMES).not.toContain('suppress');
  });
});
