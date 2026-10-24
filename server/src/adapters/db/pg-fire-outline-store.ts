/**
 * The V2-A4 estimated outlines (`FireOutlineStore`, `FireOutlineReader`) against Postgres —
 * migration 032's `event_fire_outline` and `fire_outline_pass`.
 *
 * The writer touches only its own tables, so drawing an outline never bumps the event's
 * `seq` (004's trigger watches `fire_events` alone). Members are read with the detections
 * route's own query, so the outline is drawn from exactly the live membership the event
 * page lists.
 */

import type { OutlineDetection, OutlineGeometry } from '../../core/outlines/fire-outline.js';
import type {
  ActiveFireOutline,
  ActiveFireOutlinesRead,
  FireOutlineCandidate,
  FireOutlineReader,
  FireOutlineStore,
} from '../../core/ports/fire-outline-store.js';
import { SELECT_EVENT_MEMBERS } from './pg-event-detections-reader.js';
import { epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this adapter needs; a `Pool` and a `Client` both satisfy it. */
export interface PgFireOutlineQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

/** The snapshot's active set (`pg-snapshot-reader`): what the map shows is what gets drawn. */
const ACTIVE = `e.display_tier = 'map' AND e.merged_into IS NULL AND NOT e.invalidated`;

/** `$1` params version, `$2` limit. */
export const SELECT_PENDING_OUTLINES = `
SELECT e.id::text AS id, e.detection_count, e.last_detection_at
  FROM fire_events e
  LEFT JOIN event_fire_outline o ON o.fire_event_id = e.id
 WHERE ${ACTIVE}
   AND (o.fire_event_id IS NULL
        OR o.params_version <> $1
        OR o.detection_count <> e.detection_count
        OR o.last_detection_at <> e.last_detection_at)
 ORDER BY e.last_detection_at DESC, e.id DESC
 LIMIT $2`;

export const UPSERT_OUTLINE = `
INSERT INTO event_fire_outline
  (fire_event_id, params_version, detection_count, last_detection_at, footprints, outline,
   area_ha, area_low_ha, area_high_ha, edge_uncertainty_km, computed_at)
VALUES ($1::bigint, $2, $3, $4, $5,
        CASE WHEN $6::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($6::text), 4326) END,
        $7, $8, $9, $10, $11)
ON CONFLICT (fire_event_id) DO UPDATE SET
  params_version = EXCLUDED.params_version,
  detection_count = EXCLUDED.detection_count,
  last_detection_at = EXCLUDED.last_detection_at,
  footprints = EXCLUDED.footprints,
  outline = EXCLUDED.outline,
  area_ha = EXCLUDED.area_ha,
  area_low_ha = EXCLUDED.area_low_ha,
  area_high_ha = EXCLUDED.area_high_ha,
  edge_uncertainty_km = EXCLUDED.edge_uncertainty_km,
  computed_at = EXCLUDED.computed_at`;

export const UPSERT_PASS = `
INSERT INTO fire_outline_pass (id, params_version, last_completed_at)
VALUES (1, $1, $2)
ON CONFLICT (id) DO UPDATE SET
  params_version = EXCLUDED.params_version,
  last_completed_at = EXCLUDED.last_completed_at`;

export const SELECT_PASS = `
SELECT params_version, last_completed_at FROM fire_outline_pass WHERE id = 1`;

/** `$1` params version, `$2` limit. Largest first, so a cut drops the smallest shapes. */
export const SELECT_ACTIVE_OUTLINES = `
SELECT e.public_id, ST_AsGeoJSON(o.outline, 5) AS outline, o.area_ha, o.area_low_ha,
       o.area_high_ha, o.edge_uncertainty_km, o.footprints, o.last_detection_at
  FROM fire_events e
  JOIN event_fire_outline o ON o.fire_event_id = e.id
 WHERE ${ACTIVE}
   AND o.outline IS NOT NULL
   AND o.params_version = $1
 ORDER BY o.area_ha DESC, e.public_id
 LIMIT $2`;

export function createPgFireOutlineStore(
  db: PgFireOutlineQueryable,
): FireOutlineStore & FireOutlineReader {
  return {
    async pendingEvents(paramsVersion, limit) {
      checkLimit(limit);
      const { rows } = await db.query(SELECT_PENDING_OUTLINES, [paramsVersion, String(limit)]);
      return rows.map((row): FireOutlineCandidate => ({
        eventId: string(field(row, 'id'), 'id'),
        detectionCount: number(field(row, 'detection_count'), 'detection_count'),
        lastDetectionAt: epochMs(field(row, 'last_detection_at'), 'last_detection_at'),
      }));
    },

    async members(eventId, limit) {
      checkLimit(limit);
      const { rows } = await db.query(SELECT_EVENT_MEMBERS, [eventId, String(limit)]);
      return rows.map((row): OutlineDetection => ({
        uid: string(field(row, 'detection_uid'), 'detection_uid'),
        sourceId: string(field(row, 'source'), 'source'),
        lat: decimal(field(row, 'lat'), 'lat'),
        lon: decimal(field(row, 'lon'), 'lon'),
        scanKm: optionalNumber(field(row, 'scan_km'), 'scan_km'),
        trackKm: optionalNumber(field(row, 'track_km'), 'track_km'),
      }));
    },

    async save(rows) {
      for (const row of rows) {
        await db.query(UPSERT_OUTLINE, [
          row.eventId,
          row.paramsVersion,
          row.detectionCount,
          new Date(row.lastDetectionAt),
          row.footprints,
          row.geometry === null ? null : JSON.stringify(row.geometry),
          row.areaHa,
          row.areaLowHa,
          row.areaHighHa,
          row.edgeUncertaintyKm,
          new Date(row.computedAt),
        ]);
      }
    },

    async recordPass(paramsVersion, at) {
      await db.query(UPSERT_PASS, [paramsVersion, new Date(at)]);
    },

    async readActiveOutlines(limit): Promise<ActiveFireOutlinesRead> {
      checkLimit(limit);
      const { rows: passRows } = await db.query(SELECT_PASS);
      const passRow = passRows[0];
      if (passRow === undefined) return { pass: null, outlines: [], truncated: false };
      const pass = {
        paramsVersion: string(field(passRow, 'params_version'), 'params_version'),
        completedAt: epochMs(field(passRow, 'last_completed_at'), 'last_completed_at'),
      };
      // One row past the limit tells "exactly `limit`" from "more than `limit`".
      const { rows } = await db.query(SELECT_ACTIVE_OUTLINES, [
        pass.paramsVersion,
        String(limit + 1),
      ]);
      return {
        pass,
        outlines: rows.slice(0, limit).map(decodeOutline),
        truncated: rows.length > limit,
      };
    },
  };
}

function decodeOutline(row: unknown): ActiveFireOutline {
  return {
    publicId: string(field(row, 'public_id'), 'public_id'),
    geometry: decodeGeometry(string(field(row, 'outline'), 'outline')),
    areaHa: number(field(row, 'area_ha'), 'area_ha'),
    areaLowHa: number(field(row, 'area_low_ha'), 'area_low_ha'),
    areaHighHa: number(field(row, 'area_high_ha'), 'area_high_ha'),
    edgeUncertaintyKm: number(field(row, 'edge_uncertainty_km'), 'edge_uncertainty_km'),
    footprints: number(field(row, 'footprints'), 'footprints'),
    lastDetectionAt: epochMs(field(row, 'last_detection_at'), 'last_detection_at'),
  };
}

function decodeGeometry(text: string): OutlineGeometry {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { type?: unknown }).type !== 'MultiPolygon' ||
    !Array.isArray((parsed as { coordinates?: unknown }).coordinates)
  ) {
    throw new Error('event_fire_outline.outline is not a MultiPolygon');
  }
  return parsed as OutlineGeometry;
}

function checkLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive safe integer');
  }
}

function decimal(value: unknown, name: string): number {
  return number(Number(string(value, name)), name);
}

function optionalNumber(value: unknown, name: string): number | null {
  return value === null ? null : number(value, name);
}
