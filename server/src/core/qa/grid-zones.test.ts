import { describe, expect, it } from 'vitest';

import { ALERT_GATING } from '../config/alert-gating.js';
import { alertableEnvelope } from '../config/polling-bbox.js';
import { gridAlertZone, gridZoneFor, gridZoneId, latticeShape } from './grid-zones.js';
import { QA_METRICS } from './qa-metrics-params.js';

const LATTICE = QA_METRICS.values.lattice;

describe('latticeShape', () => {
  it('spaces the cells at the configured 10 km pitch', () => {
    const shape = latticeShape();
    // 10 km of latitude is a fixed number of degrees; 10 km of longitude is not, and the
    // planar metric's reference latitude is what makes the lattice a rectangle in degrees.
    expect(shape.latStepDeg).toBeCloseTo(0.0900212, 7);
    expect(shape.lonStepDeg).toBeCloseTo(0.1220465, 7);
    expect(shape.cols).toBe(74);
    expect(shape.rows).toBe(62);
  });

  it('rounds cell counts up, so no strip of the AOI is left in no zone', () => {
    const shape = latticeShape();
    expect(shape.coverage.east).toBeGreaterThanOrEqual(LATTICE.bounds.east);
    expect(shape.coverage.north).toBeGreaterThanOrEqual(LATTICE.bounds.south);
    expect(shape.coverage.north).toBeGreaterThanOrEqual(LATTICE.bounds.north);
  });

  it('covers the whole alertable envelope, so every alertable fire has a zone', () => {
    const shape = latticeShape();
    const envelope = alertableEnvelope();
    expect(LATTICE.bounds.west).toBeLessThanOrEqual(envelope.west);
    expect(LATTICE.bounds.south).toBeLessThanOrEqual(envelope.south);
    expect(shape.coverage.east).toBeGreaterThanOrEqual(envelope.east);
    expect(shape.coverage.north).toBeGreaterThanOrEqual(envelope.north);
  });

  it('refuses a lattice whose indices outgrow the pinned id width', () => {
    const wide = { ...LATTICE, pitchKm: 0.5 };
    expect(() => latticeShape(wide)).toThrow(/config version bump/);
  });

  it('refuses bounds that enclose no cell', () => {
    const empty = { ...LATTICE, bounds: { west: 21, south: 40, east: 21, north: 40 } };
    expect(() => latticeShape(empty)).toThrow(/enclose no cell/);
  });
});

describe('gridZoneId', () => {
  it('zero-pads, so lexical order of ids is geographic order of cells', () => {
    expect(gridZoneId(0, 0)).toBe('qa_grid-c000-r000');
    expect(gridZoneId(18, 29)).toBe('qa_grid-c018-r029');
    expect([gridZoneId(10, 0), gridZoneId(9, 0), gridZoneId(2, 0)].sort()).toEqual([
      'qa_grid-c002-r000',
      'qa_grid-c009-r000',
      'qa_grid-c010-r000',
    ]);
  });
});

describe('gridZoneFor', () => {
  it('places a point in the cell that contains it', () => {
    const sofia = gridZoneFor({ lat: 42.7, lon: 23.3 });
    expect(sofia?.zoneId).toBe('qa_grid-c018-r029');
    expect(sofia?.col).toBe(18);
    expect(sofia?.row).toBe(29);
  });

  it('reports the cell bounds and centre it derived, not just an id', () => {
    const zone = gridZoneFor({ lat: 42.7, lon: 23.3 });
    expect(zone).not.toBeNull();
    if (zone === null) return;
    expect(zone.bounds.west).toBeLessThanOrEqual(23.3);
    expect(zone.bounds.east).toBeGreaterThan(23.3);
    expect(zone.bounds.south).toBeLessThanOrEqual(42.7);
    expect(zone.bounds.north).toBeGreaterThan(42.7);
    expect(zone.centre.lat).toBeCloseTo((zone.bounds.south + zone.bounds.north) / 2, 12);
    expect(zone.centre.lon).toBeCloseTo((zone.bounds.west + zone.bounds.east) / 2, 12);
  });

  it('puts the south-west corner of the lattice in cell (0, 0)', () => {
    expect(gridZoneFor({ lat: LATTICE.bounds.south, lon: LATTICE.bounds.west })?.zoneId).toBe(
      'qa_grid-c000-r000',
    );
  });

  it('returns null outside the lattice rather than clamping to an edge cell', () => {
    // Clamping would hand a fire off the AOI the alert decision of a real border zone.
    expect(gridZoneFor({ lat: 42.7, lon: 20.9 })).toBeNull();
    expect(gridZoneFor({ lat: 39.9, lon: 23.3 })).toBeNull();
    expect(gridZoneFor({ lat: 46.0, lon: 23.3 })).toBeNull();
    expect(gridZoneFor({ lat: 42.7, lon: 30.5 })).toBeNull();
  });

  it('refuses a non-finite coordinate instead of returning null for it', () => {
    expect(() => gridZoneFor({ lat: Number.NaN, lon: 23.3 })).toThrow(RangeError);
  });
});

describe('an event that spans two grid zones', () => {
  // A fire wider than the 10 km pitch touches more than one cell. The metric is defined on
  // the perimeter *centroid*, so the spanning is not the module's problem — but the two
  // cells must be genuinely distinct zones, and each point must resolve to exactly one.
  const west = { lat: 42.7, lon: 23.24 };
  const east = { lat: 42.7, lon: 23.4 };

  it('gives each half its own zone', () => {
    const a = gridZoneFor(west);
    const b = gridZoneFor(east);
    expect(a?.zoneId).toBe('qa_grid-c018-r029');
    expect(b?.zoneId).toBe('qa_grid-c019-r029');
    expect(a?.zoneId).not.toBe(b?.zoneId);
  });

  it('resolves the centroid between them to exactly one of the two', () => {
    const centroid = { lat: 42.7, lon: (west.lon + east.lon) / 2 };
    const zone = gridZoneFor(centroid);
    expect([gridZoneFor(west)?.zoneId, gridZoneFor(east)?.zoneId]).toContain(zone?.zoneId);
  });

  it('places a point on an internal edge deterministically, in one cell only', () => {
    const shape = latticeShape();
    const edgeLon = LATTICE.bounds.west + 5 * shape.lonStepDeg;
    const first = gridZoneFor({ lat: 42.7, lon: edgeLon });
    const again = gridZoneFor({ lat: 42.7, lon: edgeLon });
    expect(first?.zoneId).toBe(again?.zoneId);
    // Half-open in exact arithmetic puts it in cell 5; the reconstructed double divides
    // back a hair short and lands in 4. Either is one cell, which is what the metric needs.
    expect([4, 5]).toContain(first?.col);
  });
});

describe('gridAlertZone', () => {
  const zone = gridZoneFor({ lat: 42.7, lon: 23.3 });

  it('reads the default sensitivity and quiet hours from alert_gating_v1, never restating them', () => {
    expect(zone).not.toBeNull();
    if (zone === null) return;
    const alertZone = gridAlertZone(zone, 0);
    const gating = ALERT_GATING.values;
    expect(alertZone.zoneId).toBe(zone.zoneId);
    expect(alertZone.minScore).toBe(gating.sensitivityFloors.likely);
    expect(alertZone.timezone).toBe(gating.quietHours.timezone);
    expect(alertZone.quietHoursStart).toBe(gating.quietHours.start);
    expect(alertZone.quietHoursEnd).toBe(gating.quietHours.end);
    expect(alertZone.newFireOverridesQuietHours).toBe(LATTICE.newFireOverridesQuietHours);
  });

  it('refuses a negative distance rather than passing it to the tie-break', () => {
    expect(zone).not.toBeNull();
    if (zone === null) return;
    expect(() => gridAlertZone(zone, -1)).toThrow(RangeError);
  });
});
