import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ZONE_MATCH_METRIC, zoneMatchEnvelope } from '../../core/alerts/zone-match.js';
import { coarsenCentre, indexCellKey } from '../../core/zones/zone-geometry.js';
import {
  ZONE_SEED_CANDIDATE_SQL,
  createPgZoneSeedCandidateReader,
  seedCandidateCellRange,
  type PgSeedCandidateQueryable,
} from './pg-zone-seed-candidate-reader.js';

const CENTRE = { lat: 42.6977, lon: 23.3219 };

function row(publicId: string, lat: number, overrides: Record<string, unknown> = {}) {
  return {
    fire_event_id: '1',
    seq: '1',
    public_id: publicId,
    status: 'active',
    score: 0,
    invalidated: false,
    relation_kind: null,
    started_at: new Date('2026-08-14T11:00:00Z'),
    last_detection_at: new Date('2026-08-14T11:55:00Z'),
    lat,
    lon: CENTRE.lon,
    merged: false,
    superseded: false,
    member_count: 1,
    persistent_count: 1,
    night_high_count: 0,
    non_geo_count: 1,
    latest_quarantined: false,
    status_before: null,
    ...overrides,
  };
}

function stubDb(rows: Record<string, unknown>[]): PgSeedCandidateQueryable & {
  readonly calls: { text: string; values: readonly unknown[] }[];
} {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  return {
    calls,
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
    },
  };
}

const kmNorth = (km: number): number => CENTRE.lat + km / ZONE_MATCH_METRIC.kmPerDegreeLat;

describe('the seed-candidate reader', () => {
  it('prefilters on an integer index-cell box over the gist index and excludes tombstones', () => {
    const sql = ZONE_SEED_CANDIDATE_SQL.selectCandidates;
    expect(sql).toContain('e.centroid && ST_MakeEnvelope(');
    expect(sql).toContain('$3::int::float8 / $5::int, $1::int::float8 / $5::int');
    expect(sql).toContain('($4::int + 1)::float8 / $5::int, ($2::int + 1)::float8 / $5::int');
    expect(sql).toContain('e.merged_into IS NULL');
  });

  it('binds only the snapped cell range and the grid resolution', async () => {
    const db = stubDb([]);
    await createPgZoneSeedCandidateReader(db).candidatesWithin(CENTRE, 10_000);
    const range = seedCandidateCellRange(CENTRE, 10_000);
    expect(db.calls[0]?.values).toEqual([
      range.latFrom,
      range.latTo,
      range.lonFrom,
      range.lonTo,
      20,
    ]);
    for (const value of db.calls[0]?.values ?? []) expect(Number.isInteger(value)).toBe(true);
  });

  it('snaps outward: the cell box always contains the zone-match envelope', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 41, max: 44.3, noNaN: true }),
        fc.double({ min: 22.3, max: 28.7, noNaN: true }),
        fc.integer({ min: 2_000, max: 30_000 }),
        (lat, lon, radiusM) => {
          const range = seedCandidateCellRange({ lat, lon }, radiusM);
          const box = zoneMatchEnvelope({ lat, lon }, radiusM);
          const p = range.cellsPerDegree;
          expect(range.latFrom / p).toBeLessThan(box.minLat);
          expect(range.lonFrom / p).toBeLessThan(box.minLon);
          expect((range.latTo + 1) / p).toBeGreaterThan(box.maxLat);
          expect((range.lonTo + 1) / p).toBeGreaterThan(box.maxLon);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('never binds the centre, and resolves it no finer than the clear index cell', async () => {
    // 05 §5.3.2: the zone row stores its ~5 km index cell and its radius in clear. Two
    // centres in the same index cell with the same radius bind cell indices at most one
    // apart, so the statement discloses nothing finer than the row already does.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 41 * 20, max: 44 * 20 }),
        fc.integer({ min: 23 * 20, max: 28 * 20 }),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 2, max: 30 }),
        async (latCell, lonCell, a, b, c, d, radiusKm) => {
          // Stored centres are on the 0.01° lattice: five of them per 0.05° index cell.
          const first = coarsenCentre({
            lat: (latCell * 5 + a) / 100,
            lon: (lonCell * 5 + b) / 100,
          });
          const second = coarsenCentre({
            lat: (latCell * 5 + c) / 100,
            lon: (lonCell * 5 + d) / 100,
          });
          if (indexCellKey(first) !== indexCellKey(second)) return; // float edge; not this claim
          const db = stubDb([]);
          const reader = createPgZoneSeedCandidateReader(db);
          await reader.candidatesWithin(first, radiusKm * 1000);
          await reader.candidatesWithin(second, radiusKm * 1000);
          const [one, two] = db.calls;
          // The lattice snap makes adjacent-cell centres differ by at most one cell index.
          for (let i = 0; i < 4; i += 1) {
            expect(Math.abs(Number(one?.values[i]) - Number(two?.values[i]))).toBeLessThanOrEqual(
              1,
            );
          }
          for (const values of [one?.values ?? [], two?.values ?? []]) {
            expect(values).not.toContain(first.lat);
            expect(values).not.toContain(first.lon);
            expect(values).not.toContain(second.lat);
            expect(values).not.toContain(second.lon);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('carries the fire event id and seq the decision log keys on', async () => {
    const db = stubDb([row('fw-2026-aaaaa', CENTRE.lat, { fire_event_id: '42', seq: '7' })]);
    const [candidate] = await createPgZoneSeedCandidateReader(db).candidatesWithin(CENTRE, 5_000);
    expect(candidate?.fireEventId).toBe('42');
    expect(candidate?.seq).toBe('7');
  });

  it('keeps exactly the events the zone-match test accepts, with their distance', async () => {
    const db = stubDb([
      row('fw-2026-aaaaa', kmNorth(4)),
      row('fw-2026-bbbbb', kmNorth(10.5)),
      row('fw-2026-ccccc', kmNorth(10)),
    ]);
    const candidates = await createPgZoneSeedCandidateReader(db).candidatesWithin(CENTRE, 10_000);
    expect(candidates.map((c) => c.event.publicId)).toEqual(['fw-2026-aaaaa', 'fw-2026-ccccc']);
    expect(candidates[0]?.distanceKm).toBeCloseTo(4, 6);
  });

  it('drops merged, superseded and memberless events, as the live loop does', async () => {
    const db = stubDb([
      row('fw-2026-aaaaa', CENTRE.lat, { merged: true }),
      row('fw-2026-bbbbb', CENTRE.lat, { superseded: true }),
      row('fw-2026-ccccc', CENTRE.lat, { member_count: 0, persistent_count: 0, non_geo_count: 0 }),
      row('fw-2026-ddddd', CENTRE.lat),
    ]);
    const candidates = await createPgZoneSeedCandidateReader(db).candidatesWithin(CENTRE, 5_000);
    expect(candidates.map((c) => c.event.publicId)).toEqual(['fw-2026-ddddd']);
  });

  it('rejects a bad radius before querying', async () => {
    const db = stubDb([]);
    await expect(createPgZoneSeedCandidateReader(db).candidatesWithin(CENTRE, -1)).rejects.toThrow(
      RangeError,
    );
    expect(db.calls).toEqual([]);
  });
});
