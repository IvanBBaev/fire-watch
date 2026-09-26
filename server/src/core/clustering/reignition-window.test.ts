import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import { CLUSTERING_PARAMS, FUEL_BANDS } from './clustering-params.js';
import { distanceKm, quantizeKm } from './geometry.js';
import {
  chooseReignitionParent,
  compareReignitionParent,
  type ReignitionCandidate,
  reignitionRadiusKm,
  reignitionWindowDays,
  reignitionWindowMs,
} from './reignition-window.js';

const DAY_MS = 86_400_000;
const METRIC = CLUSTERING_PARAMS.values.metric;

describe('reignitionWindowDays', () => {
  it('is the fuel-specific window ADR-002 D2 states', () => {
    expect(reignitionWindowDays('grass')).toBe(7);
    expect(reignitionWindowDays('mixed')).toBe(14);
    expect(reignitionWindowDays('forest')).toBe(21);
  });

  it('covers every band, so no classification can fall through', () => {
    for (const band of FUEL_BANDS) {
      expect(reignitionWindowDays(band)).toBeGreaterThan(0);
    }
  });

  it('converts to milliseconds without drifting', () => {
    expect(reignitionWindowMs('forest')).toBe(21 * DAY_MS);
  });
});

describe('Appendix A rule 5 — unclassified fuel takes the middle band', () => {
  // "Unclassified, null, or no land-cover class holding a ≥ 50 % majority under the hull
  // all resolve to the 14 d middle band — never 7 d, never 21–30 d."

  it('resolves an unknown fuel to 14 days', () => {
    expect(reignitionWindowDays(null)).toBe(14);
  });

  it('is the assertion that separates the middle band from the safe-looking alternatives', () => {
    // Both wrong readings look defensible in isolation. 7 d is "be conservative, claim
    // fewer reignitions" — and it refuses to relate a forest fire that came back on day
    // 10, which is precisely the case a reader of the map cares about. 21 d is "be
    // generous" — and it attaches a reignition claim to a stubble field burnt twice in a
    // fortnight, which is a claim about a real place that happens to be false. The rule
    // picks neither; this test fails the day someone picks one.
    expect(reignitionWindowDays(null)).not.toBe(reignitionWindowDays('grass'));
    expect(reignitionWindowDays(null)).not.toBe(reignitionWindowDays('forest'));
    expect(reignitionWindowMs(null)).toBe(14 * DAY_MS);
  });
});

describe('reignitionRadiusKm', () => {
  it('is 2·ε (Appendix A rule 3 measures inclusively against it)', () => {
    // Two detections of one fire are always within ε of a chain member, so a candidate one
    // ε from the *edge* of an old cluster is two ε from where that cluster was first seen.
    expect(reignitionRadiusKm(1.25)).toBe(2.5);
    expect(reignitionRadiusKm(3)).toBe(6);
  });

  it('refuses a non-finite or non-positive ε', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reignitionRadiusKm(bad)).toThrow(RangeError);
    }
  });
});

describe('Appendix A rule 2 — nearest centroid, then oldest, then lowest internal id', () => {
  // The new fire, and two old ones that are the *same* distance from it once distances are
  // quantised. Found by search rather than by symmetry: exactly symmetric offsets on the
  // 5-decimal grid come out bit-identical, which would make the quantum look unnecessary.
  // These two differ by 1.9e-7 km — 0.19 mm, a fifth of the quantum and six orders of
  // magnitude below the 1.1 m coordinate grid, so they are the same distance in every
  // sense except the last bits of a double.
  const AT = { lat: 42.0, lon: 24.0 } as const;
  const NORTH_CENTROID = { lat: 42.01494, lon: 24.0 } as const;
  const EAST_CENTROID = { lat: 42.0, lon: 24.02003 } as const;

  function candidate(spec: {
    id: number;
    startedAtIso: string;
    centroid: { lat: number; lon: number };
  }): ReignitionCandidate {
    return {
      clusterId: spec.id,
      publicId: `fw-2026-${String(spec.id).padStart(5, '0')}`,
      centroid: spec.centroid,
      startedAt: epochMsFromIso(spec.startedAtIso),
    };
  }

  it('takes the nearest centroid even when a farther event is older and lower-numbered', () => {
    // The primary key, against the two things that would otherwise look like reasonable
    // defaults. A reignition claim names a specific past fire on the map; "the oldest one
    // in the valley" is a different claim from "the one that was burning here".
    const far = candidate({
      id: 1,
      startedAtIso: '2026-07-01T00:00:00Z',
      centroid: { lat: 42.03, lon: 24.0 },
    });
    const near = candidate({
      id: 9,
      startedAtIso: '2026-08-01T00:00:00Z',
      centroid: { lat: 42.01, lon: 24.0 },
    });

    expect(chooseReignitionParent([far, near], AT)).toBe(near);
    expect(chooseReignitionParent([near, far], AT)).toBe(near);
  });

  it('breaks an exact distance tie by the oldest event, not the lowest id', () => {
    // Both alternatives lose here on purpose. The eastern candidate is a whisker *farther*
    // in raw floating point and carries the higher id, so it wins only if the distances are
    // compared quantised and `started_at` is the second key.
    const east = candidate({
      id: 9,
      startedAtIso: '2026-08-01T00:00:00Z',
      centroid: EAST_CENTROID,
    });
    const north = candidate({
      id: 2,
      startedAtIso: '2026-08-02T00:00:00Z',
      centroid: NORTH_CENTROID,
    });

    expect(chooseReignitionParent([north, east], AT)).toBe(east);
    expect(chooseReignitionParent([east, north], AT)).toBe(east);
  });

  it('breaks a full tie by the lowest internal id', () => {
    const east = candidate({
      id: 4,
      startedAtIso: '2026-08-01T00:00:00Z',
      centroid: EAST_CENTROID,
    });
    const north = candidate({
      id: 12,
      startedAtIso: '2026-08-01T00:00:00Z',
      centroid: NORTH_CENTROID,
    });

    expect(chooseReignitionParent([north, east], AT)).toBe(east);
    expect(chooseReignitionParent([east, north], AT)).toBe(east);
  });

  it('is only a tie because the comparison is quantised — the raw distances differ', () => {
    // The assertion that keeps the two tests above honest. Without it a future edit could
    // drop the quantisation, both tests would still pass by luck of which candidate happens
    // to be nearer in the last bits, and the pinned rules would become dead code.
    const north = distanceKm(NORTH_CENTROID, AT, METRIC);
    const east = distanceKm(EAST_CENTROID, AT, METRIC);
    expect(north).not.toBe(east);
    expect(Math.abs(north - east)).toBeLessThan(METRIC.quantumKm);
    expect(quantizeKm(north, METRIC)).toBe(quantizeKm(east, METRIC));
    // And the raw order is the opposite of the pinned answer, so a regression is visible.
    expect(north).toBeLessThan(east);
  });

  it('picks the same parent whatever order the candidates are read back in', () => {
    // D3 loads these from `fire_events`; a query without an ORDER BY, an index change, or a
    // vacuum can all reorder them. The parent of a fire must not depend on any of that.
    const candidates = [
      candidate({ id: 3, startedAtIso: '2026-08-01T00:00:00Z', centroid: NORTH_CENTROID }),
      candidate({ id: 8, startedAtIso: '2026-07-20T00:00:00Z', centroid: EAST_CENTROID }),
      candidate({
        id: 1,
        startedAtIso: '2026-07-01T00:00:00Z',
        centroid: { lat: 42.04, lon: 24.0 },
      }),
      candidate({ id: 5, startedAtIso: '2026-07-20T00:00:00Z', centroid: NORTH_CENTROID }),
    ];
    // 5 is the answer, and all three keys are needed to get there: 1 is eliminated on
    // distance, 3 on the oldest start, and 8 — which ties with 5 on both — on the id.
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
      expect(chooseReignitionParent(rotated, AT)?.clusterId).toBe(5);
    }
  });

  it('is a total order over the candidates', () => {
    const candidates = [
      candidate({ id: 3, startedAtIso: '2026-08-01T00:00:00Z', centroid: NORTH_CENTROID }),
      candidate({ id: 8, startedAtIso: '2026-07-20T00:00:00Z', centroid: EAST_CENTROID }),
      candidate({
        id: 1,
        startedAtIso: '2026-07-01T00:00:00Z',
        centroid: { lat: 42.04, lon: 24.0 },
      }),
    ];
    for (const a of candidates) {
      for (const b of candidates) {
        if (a === b) {
          expect(compareReignitionParent(a, b, AT)).toBe(0);
        } else {
          expect(compareReignitionParent(a, b, AT)).not.toBe(0);
          expect(Math.sign(compareReignitionParent(a, b, AT))).toBe(
            -Math.sign(compareReignitionParent(b, a, AT)),
          );
        }
      }
    }
  });

  it('returns null when nothing is eligible, because most new fires are just new fires', () => {
    expect(chooseReignitionParent([], AT)).toBeNull();
  });
});
