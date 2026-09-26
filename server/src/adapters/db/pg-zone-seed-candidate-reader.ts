/**
 * The pg {@link ZoneSeedCandidateReader} (ADR-004 A1.8; TASKS H3/I2): the events a new or
 * enlarged zone's seed plan runs over.
 *
 * Same projection and decoder as the live evaluation loop (`pg-alertable-events.ts`), so a
 * fire looks the same to the gate whether the fire moved or the zone was drawn. Same
 * distance too: the exact test is `zoneDistanceWithin` in TypeScript — never PostGIS's own
 * distance, which would disagree with the live loop at the boundary.
 *
 * **The index prefilter never carries the centre.** An earlier version bound the corners of
 * `zoneMatchEnvelope` — four floats whose midpoint *is* the stored centre, which would have
 * put a 0.01° location into every statement log that prints parameters. The box is now
 * snapped outward onto the zone index grid (`ZONE_GRID.indexCellsPerDegree`, ~5 km) and
 * bound as integer cell indices plus the grid's cells-per-degree; the division happens in
 * SQL. Those integers say no more than the zone row's clear `grid_cell` plus its radius,
 * both already stored unencrypted by design (05 §5.3.2). `fire_events_centroid_gist` still
 * serves the `&&`.
 *
 * Excluded, as in the live loop: merged tombstones, superseded parents (their state is
 * folded onto the successor, which is a candidate in its own right), and events with no
 * live member. Everything else is returned regardless of the gate, as the port requires.
 *
 * Runs on the zone-creation transaction's client — no BEGIN here.
 */

import type { Coordinate } from '../../core/clustering/geometry.js';
import { zoneDistanceWithin, zoneMatchEnvelope } from '../../core/alerts/zone-match.js';
import type {
  ZoneSeedCandidateReader,
  ZoneSeedCandidateRow,
} from '../../core/ports/zone-seed-candidate-reader.js';
import { ZONE_GRID } from '../../core/zones/zone-geometry.js';
import {
  ALERTABLE_EVENT_COLUMNS,
  ALERTABLE_EVENT_JOINS,
  decodeEvaluationEventRow,
} from './pg-alertable-events.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgSeedCandidateQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * `$1..$4` are inclusive cell indices (lat from/to, lon from/to), `$5` cells per degree.
 * Cell `k` spans `[k/p, (k+1)/p)`, so the box's upper edges are `(to + 1) / p`.
 */
const SELECT_CANDIDATES = `
SELECT ${ALERTABLE_EVENT_COLUMNS}
FROM fire_events e
${ALERTABLE_EVENT_JOINS}
WHERE e.centroid && ST_MakeEnvelope(
    $3::int::float8 / $5::int, $1::int::float8 / $5::int,
    ($4::int + 1)::float8 / $5::int, ($2::int + 1)::float8 / $5::int,
    4326)
  AND e.merged_into IS NULL
ORDER BY e.id`.trim();

export const ZONE_SEED_CANDIDATE_SQL = Object.freeze({ selectCandidates: SELECT_CANDIDATES });

/** An inclusive range of index cells, as bound to {@link SELECT_CANDIDATES}. */
export interface IndexCellRange {
  readonly latFrom: number;
  readonly latTo: number;
  readonly lonFrom: number;
  readonly lonTo: number;
  readonly cellsPerDegree: number;
}

/**
 * The index cells covering the zone-match envelope, snapped outward with one cell of slack
 * on every side — the same slack `indexCellsWithin` uses — so a floating-point edge at a
 * cell boundary can never drop an event the exact test would have kept.
 */
export function seedCandidateCellRange(
  centre: Coordinate,
  radiusM: number,
  cellsPerDegree: number = ZONE_GRID.values.indexCellsPerDegree,
): IndexCellRange {
  if (!Number.isInteger(cellsPerDegree) || cellsPerDegree < 1) {
    throw new RangeError(
      `cells per degree must be a positive integer, got ${String(cellsPerDegree)}`,
    );
  }
  const box = zoneMatchEnvelope(centre, radiusM);
  return {
    latFrom: Math.floor(box.minLat * cellsPerDegree) - 1,
    latTo: Math.floor(box.maxLat * cellsPerDegree) + 1,
    lonFrom: Math.floor(box.minLon * cellsPerDegree) - 1,
    lonTo: Math.floor(box.maxLon * cellsPerDegree) + 1,
    cellsPerDegree,
  };
}

export function createPgZoneSeedCandidateReader(
  db: PgSeedCandidateQueryable,
): ZoneSeedCandidateReader {
  return {
    async candidatesWithin(
      centre: Coordinate,
      radiusM: number,
    ): Promise<readonly ZoneSeedCandidateRow[]> {
      const range = seedCandidateCellRange(centre, radiusM);
      const result = await db.query(SELECT_CANDIDATES, [
        range.latFrom,
        range.latTo,
        range.lonFrom,
        range.lonTo,
        range.cellsPerDegree,
      ]);
      const candidates: ZoneSeedCandidateRow[] = [];
      for (const raw of result.rows) {
        const row = decodeEvaluationEventRow(raw);
        if (row.merged || row.superseded || row.memberCount === 0) continue;
        const distanceKm = zoneDistanceWithin(centre, radiusM, row.centroid);
        if (distanceKm === null) continue;
        candidates.push({
          event: row.event,
          distanceKm,
          fireEventId: row.fireEventId,
          seq: row.seq,
        });
      }
      return candidates;
    },
  };
}
