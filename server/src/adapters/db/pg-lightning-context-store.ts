/**
 * The F18 lightning context (`LightningContextStore`, `LightningContextReader`) against
 * Postgres — migration 022's `event_lightning_context`.
 *
 * The writer touches only its own table, so answering for an event never bumps the
 * event's `seq` (004's trigger watches `fire_events` alone). The reader follows the merge
 * chain the same way the detections read does: a merged-away public id answers with its
 * survivor's context, because the survivor carries the earliest first detection.
 */

import type {
  LightningContextCandidate,
  LightningContextRead,
  LightningContextReader,
  LightningContextRow,
  LightningContextStore,
} from '../../core/ports/lightning-context-store.js';
import { MAX_MERGE_CHAIN, SELECT_EVENT_CHAIN } from './pg-event-detections-reader.js';
import { epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this adapter needs; a `Pool` and a `Client` both satisfy it. */
export interface PgLightningContextQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

/** Live events with no answer under the current parameters, newest first detection first. */
export const SELECT_PENDING_CONTEXT = `
SELECT e.id::text AS id, ST_Y(e.centroid) AS lat, ST_X(e.centroid) AS lon, e.started_at
  FROM fire_events e
  LEFT JOIN event_lightning_context c ON c.fire_event_id = e.id
 WHERE e.merged_into IS NULL
   AND NOT e.invalidated
   AND (c.fire_event_id IS NULL OR c.params_version <> $1)
 ORDER BY e.started_at DESC, e.id DESC
 LIMIT $2`;

export const UPSERT_CONTEXT = `
INSERT INTO event_lightning_context
  (fire_event_id, status, window_from, window_to, radius_km, flash_count, nearest_km,
   params_version, filter_version, computed_at)
VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (fire_event_id) DO UPDATE SET
  status = EXCLUDED.status,
  window_from = EXCLUDED.window_from,
  window_to = EXCLUDED.window_to,
  radius_km = EXCLUDED.radius_km,
  flash_count = EXCLUDED.flash_count,
  nearest_km = EXCLUDED.nearest_km,
  params_version = EXCLUDED.params_version,
  filter_version = EXCLUDED.filter_version,
  computed_at = EXCLUDED.computed_at`;

export const SELECT_CONTEXT = `
SELECT e.started_at, c.status, c.window_from, c.window_to, c.radius_km, c.flash_count,
       c.nearest_km, c.params_version, c.filter_version, c.computed_at
  FROM fire_events e
  LEFT JOIN event_lightning_context c ON c.fire_event_id = e.id
 WHERE e.id = $1::bigint`;

export function createPgLightningContextStore(
  db: PgLightningContextQueryable,
): LightningContextStore & LightningContextReader {
  return {
    async pendingEvents(paramsVersion, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('limit must be a positive safe integer');
      }
      const { rows } = await db.query(SELECT_PENDING_CONTEXT, [paramsVersion, String(limit)]);
      return rows.map((row): LightningContextCandidate => ({
        eventId: string(field(row, 'id'), 'id'),
        lat: number(field(row, 'lat'), 'lat'),
        lon: number(field(row, 'lon'), 'lon'),
        firstDetectedAt: epochMs(field(row, 'started_at'), 'started_at'),
      }));
    },

    async save(rows) {
      for (const row of rows) {
        await db.query(UPSERT_CONTEXT, [
          row.eventId,
          row.status,
          new Date(row.windowFrom),
          new Date(row.windowTo),
          row.radiusKm,
          row.flashCount,
          row.nearestKm,
          row.paramsVersion,
          row.filterVersion,
          new Date(row.computedAt),
        ]);
      }
    },

    async readLightningContext(publicId): Promise<LightningContextRead> {
      const { rows: chain } = await db.query(SELECT_EVENT_CHAIN, [publicId]);
      const last = chain[chain.length - 1];
      if (last === undefined) return { kind: 'unknown' };
      if (field(last, 'merged_into') !== null) {
        throw new Error(`merge chain does not end within ${String(MAX_MERGE_CHAIN)} hops`);
      }
      const eventId = string(field(last, 'id'), 'id');
      const { rows } = await db.query(SELECT_CONTEXT, [eventId]);
      const row = rows[0];
      if (row === undefined) return { kind: 'unknown' };
      const firstDetectedAt = epochMs(field(row, 'started_at'), 'started_at');
      return { kind: 'event', firstDetectedAt, row: decodeRow(eventId, row) };
    },
  };
}

function decodeRow(eventId: string, row: unknown): LightningContextRow | null {
  const status = field(row, 'status');
  if (status === null) return null;
  if (status !== 'complete' && status !== 'unavailable') {
    throw new Error(
      `event_lightning_context.status holds an unknown value: ${JSON.stringify(status)}`,
    );
  }
  const flashCount = field(row, 'flash_count');
  const nearestKm = field(row, 'nearest_km');
  return {
    eventId,
    status,
    windowFrom: epochMs(field(row, 'window_from'), 'window_from'),
    windowTo: epochMs(field(row, 'window_to'), 'window_to'),
    radiusKm: tenth(number(field(row, 'radius_km'), 'radius_km')),
    flashCount: flashCount === null ? null : number(flashCount, 'flash_count'),
    nearestKm: nearestKm === null ? null : tenth(number(nearestKm, 'nearest_km')),
    paramsVersion: string(field(row, 'params_version'), 'params_version'),
    filterVersion: string(field(row, 'filter_version'), 'filter_version'),
    computedAt: epochMs(field(row, 'computed_at'), 'computed_at'),
  };
}

/** `real` columns come back widened to a double (5.6 reads as 5.599999…); km keep a tenth. */
function tenth(km: number): number {
  return Math.round(km * 10) / 10;
}
