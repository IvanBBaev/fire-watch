import { describe, expect, it } from 'vitest';

import { gridZoneFor } from './grid-zones.js';
import { QA_METRICS } from './qa-metrics-params.js';
import { shadowPcr, type PerimeterCase } from './shadow-pcr.js';

const CENTROID = { lat: 42.7, lon: 23.3 };
const ZONE_ID = gridZoneFor(CENTROID)?.zoneId ?? 'unreachable';
const END = Date.UTC(2026, 7, 20, 12, 0, 0);
const STARTED = Date.UTC(2026, 7, 18, 3, 0, 0);

function perimeter(overrides: Partial<PerimeterCase> = {}): PerimeterCase {
  const id = overrides.perimeterId ?? 'p1';
  return {
    perimeterId: id,
    areaHa: 120,
    centroid: CENTROID,
    endAtMs: END,
    candidates: [{ publicId: `e-${id}`, intersectsBufferedPerimeter: true, startedAtMs: STARTED }],
    zoneDecisions: [{ zoneId: ZONE_ID, eventPublicId: `e-${id}`, outcome: 'send' }],
    ...overrides,
  };
}

/** Enough matched perimeters to clear the CP1 minimum n. */
function population(
  count: number,
  overrides: (index: number) => Partial<PerimeterCase> = () => ({}),
): PerimeterCase[] {
  return Array.from({ length: count }, (_unused, index) =>
    perimeter({ perimeterId: `p${String(index)}`, ...overrides(index) }),
  );
}

describe('the two criteria', () => {
  it('counts a perimeter only when it is both covered and alerted', () => {
    const report = shadowPcr({ perimeters: [perimeter()] });
    const verdict = report.perimeters[0];
    expect(verdict?.covered).toBe(true);
    expect(verdict?.alerted).toBe(true);
    expect(verdict?.counted).toBe(true);
    expect(verdict?.coveringEventIds).toEqual(['e-p1']);
    expect(verdict?.alertingEventIds).toEqual(['e-p1']);
  });

  it('does not count an event that never intersected the buffered perimeter', () => {
    const report = shadowPcr({
      perimeters: [
        perimeter({
          candidates: [
            { publicId: 'e-p1', intersectsBufferedPerimeter: false, startedAtMs: STARTED },
          ],
        }),
      ],
    });
    expect(report.perimeters[0]?.covered).toBe(false);
    expect(report.perimeters[0]?.counted).toBe(false);
  });

  it('separates "never saw it" from "saw it and said nothing"', () => {
    const report = shadowPcr({
      perimeters: [
        perimeter({
          perimeterId: 'seen-but-silent',
          zoneDecisions: [
            { zoneId: ZONE_ID, eventPublicId: 'e-seen-but-silent', outcome: 'suppress' },
          ],
        }),
      ],
    });
    const stratum = report.strata[0];
    expect(stratum?.coverageOnly.rate).toBe(1);
    expect(stratum?.rate.rate).toBe(0);
  });
});

describe('criterion (a) at the perimeter end date', () => {
  it('accepts an event that started exactly on the perimeter end instant', () => {
    const report = shadowPcr({
      perimeters: [
        perimeter({
          candidates: [{ publicId: 'e-p1', intersectsBufferedPerimeter: true, startedAtMs: END }],
        }),
      ],
    });
    expect(report.perimeters[0]?.covered).toBe(true);
  });

  it('rejects an event that started one millisecond after it', () => {
    const report = shadowPcr({
      perimeters: [
        perimeter({
          candidates: [
            { publicId: 'e-p1', intersectsBufferedPerimeter: true, startedAtMs: END + 1 },
          ],
        }),
      ],
    });
    expect(report.perimeters[0]?.covered).toBe(false);
    expect(report.perimeters[0]?.coveringEventIds).toEqual([]);
  });
});

describe('criterion (b): what counts as an alert', () => {
  it.each([
    ['send', true],
    ['defer', true],
    ['seed', false],
    ['suppress', false],
  ] as const)('%s counts as alerting: %s', (outcome, alerting) => {
    const report = shadowPcr({
      perimeters: [
        perimeter({ zoneDecisions: [{ zoneId: ZONE_ID, eventPublicId: 'e-p1', outcome }] }),
      ],
    });
    expect(report.perimeters[0]?.alerted).toBe(alerting);
  });

  it('ignores a send in a neighbouring cell when the event spans two grid zones', () => {
    const neighbour = gridZoneFor({ lat: 42.7, lon: 23.4 })?.zoneId ?? 'unreachable';
    expect(neighbour).not.toBe(ZONE_ID);
    const report = shadowPcr({
      perimeters: [
        perimeter({
          zoneDecisions: [
            { zoneId: neighbour, eventPublicId: 'e-p1', outcome: 'send' },
            { zoneId: ZONE_ID, eventPublicId: 'e-p1', outcome: 'suppress' },
          ],
        }),
      ],
    });
    expect(report.perimeters[0]?.zoneId).toBe(ZONE_ID);
    expect(report.perimeters[0]?.alerted).toBe(false);
  });

  it('ignores an alert for an event that did not cover the perimeter', () => {
    const report = shadowPcr({
      perimeters: [
        perimeter({
          candidates: [
            { publicId: 'e-p1', intersectsBufferedPerimeter: false, startedAtMs: STARTED },
          ],
          zoneDecisions: [{ zoneId: ZONE_ID, eventPublicId: 'e-p1', outcome: 'send' }],
        }),
      ],
    });
    expect(report.perimeters[0]?.alertingEventIds).toEqual([]);
  });
});

describe('the two populations', () => {
  it('puts a perimeter of exactly 50 ha in the gating stratum', () => {
    const report = shadowPcr({ perimeters: [perimeter({ areaHa: 50 })] });
    const gating = report.strata.find((stratum) => stratum.gating);
    expect(gating?.minAreaHa).toBe(50);
    expect(gating?.rate.denominator).toBe(1);
  });

  it('keeps a perimeter a hair under 50 ha out of the gating stratum but in the ≥ 10 ha one', () => {
    const report = shadowPcr({ perimeters: [perimeter({ areaHa: 49.99 })] });
    expect(report.strata.find((stratum) => stratum.gating)?.rate.denominator).toBe(0);
    expect(report.strata.find((stratum) => !stratum.gating)?.rate.denominator).toBe(1);
  });

  it('nests the populations: every ≥ 50 ha perimeter is also in the ≥ 10 ha report', () => {
    const report = shadowPcr({
      perimeters: [perimeter({ areaHa: 80 }), perimeter({ perimeterId: 'p2', areaHa: 12 })],
    });
    expect(report.strata.find((stratum) => stratum.gating)?.rate.denominator).toBe(1);
    expect(report.strata.find((stratum) => !stratum.gating)?.rate.denominator).toBe(2);
  });

  it('marks only the gating stratum as informative-or-not, with its documented target', () => {
    const report = shadowPcr({ perimeters: [] });
    expect(
      report.strata.map((stratum) => [stratum.minAreaHa, stratum.targetRate, stratum.gating]),
    ).toEqual([
      [50, 0.95, true],
      [10, 0.85, false],
    ]);
  });
});

describe('an empty denominator', () => {
  it('reports the rate as absent, never as 0 and never as 1', () => {
    const report = shadowPcr({ perimeters: [] });
    for (const stratum of report.strata) {
      expect(stratum.rate.denominator).toBe(0);
      expect(stratum.rate.rate).toBeNull();
      expect(stratum.coverageOnly.rate).toBeNull();
      expect(stratum.meetsTarget).toBeNull();
    }
  });

  it('calls a season with no perimeters under-powered rather than passed', () => {
    const report = shadowPcr({ perimeters: [] });
    expect(report.strata.find((stratum) => stratum.gating)?.underPowered).toBe(true);
  });
});

describe('minimum n', () => {
  it('flags a gating population below the documented 20', () => {
    const report = shadowPcr({ perimeters: population(19) });
    const gating = report.strata.find((stratum) => stratum.gating);
    expect(gating?.rate.rate).toBe(1);
    // The rate meets the target and the sample still cannot carry the gate.
    expect(gating?.meetsTarget).toBe(true);
    expect(gating?.underPowered).toBe(true);
  });

  it('stops flagging at exactly 20', () => {
    const report = shadowPcr({ perimeters: population(20) });
    expect(report.strata.find((stratum) => stratum.gating)?.underPowered).toBe(false);
  });

  it('never flags the informative ≥ 10 ha stratum, which carries no gate', () => {
    const report = shadowPcr({ perimeters: population(1) });
    expect(report.strata.find((stratum) => !stratum.gating)?.underPowered).toBe(false);
  });
});

describe('the 95% threshold', () => {
  it('passes a population sitting exactly on it', () => {
    const perimeters = population(20, (index) =>
      index === 0
        ? { zoneDecisions: [{ zoneId: ZONE_ID, eventPublicId: 'e-p0', outcome: 'suppress' }] }
        : {},
    );
    const gating = shadowPcr({ perimeters }).strata.find((stratum) => stratum.gating);
    expect(gating?.rate.numerator).toBe(19);
    expect(gating?.rate.denominator).toBe(20);
    expect(gating?.meetsTarget).toBe(true);
  });

  it('fails one perimeter below it', () => {
    const perimeters = population(20, (index) =>
      index < 2
        ? {
            zoneDecisions: [
              { zoneId: ZONE_ID, eventPublicId: `e-p${String(index)}`, outcome: 'suppress' },
            ],
          }
        : {},
    );
    expect(shadowPcr({ perimeters }).strata.find((stratum) => stratum.gating)?.meetsTarget).toBe(
      false,
    );
  });
});

describe('perimeters outside the lattice', () => {
  const outside = perimeter({ perimeterId: 'aegean', centroid: { lat: 38.5, lon: 25.0 } });

  it('excludes them from both numerator and denominator', () => {
    const report = shadowPcr({ perimeters: [perimeter(), outside] });
    expect(report.strata.find((stratum) => stratum.gating)?.rate.denominator).toBe(1);
  });

  it('lists them one by one with the reason, so an exclusion cannot hide a miss', () => {
    const report = shadowPcr({ perimeters: [perimeter(), outside] });
    expect(report.excluded.map((verdict) => verdict.perimeterId)).toEqual(['aegean']);
    expect(report.excluded[0]?.excluded).toBe('centroid_outside_lattice');
    expect(report.excluded[0]?.zoneId).toBeNull();
    // Coverage is still recorded — the fire was or was not seen regardless of the zone.
    expect(report.excluded[0]?.covered).toBe(true);
    expect(report.excluded[0]?.counted).toBe(false);
  });
});

describe('the report as an evidence artifact', () => {
  it('carries the config version and digest CP1 asks to be pinned', () => {
    const report = shadowPcr({ perimeters: [] });
    expect(report.configVersion).toBe(QA_METRICS.version);
    expect(report.configDigest).toBe(QA_METRICS.digest);
  });

  it('preserves the caller order rather than imposing a locale-shaped collation', () => {
    const ids = ['ostrica', 'Ätna', 'zzz', 'ıspartra'];
    const report = shadowPcr({ perimeters: ids.map((id) => perimeter({ perimeterId: id })) });
    expect(report.perimeters.map((verdict) => verdict.perimeterId)).toEqual(ids);
  });

  it('rejects a repeated perimeter rather than double-counting the denominator', () => {
    expect(() => shadowPcr({ perimeters: [perimeter(), perimeter()] })).toThrow(/duplicate/);
  });

  it('rejects a negative area rather than silently stratifying it', () => {
    expect(() => shadowPcr({ perimeters: [perimeter({ areaHa: -1 })] })).toThrow(RangeError);
  });
});
