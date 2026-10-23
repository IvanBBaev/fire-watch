/**
 * The window read behind `GET /api/v1/history` (V2-A1 playback).
 *
 * One statement: a range scan of `detections` on its primary key's leading `acq_ts` (the
 * monthly partitions outside the window are pruned), newest first and limited, so a week
 * costs at most `limit` rows however busy the season was. Each row then looks up the live
 * event holding it through `event_detections_by_detection (clustering_run_id,
 * detection_uid)` — one probe per live run, and there are few live runs.
 *
 * Quarantined rows are kept: the column's contract (migration 002) is that alerting skips
 * them and the map and the archive do not. Coordinates travel as text so the hashed 5-dp
 * decimals are not widened by the driver's float parser before the core quantises them.
 */

import type { HistoryDetectionRow, HistoryReader } from '../../core/ports/history-reader.js';
import { epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this adapter needs; a `Pool` and a `Client` both satisfy it. */
export interface PgHistoryReadable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

/**
 * `$1`/`$2` bound the window (half-open), `$3` is the row limit. When several live events
 * hold one detection (a transient state between a merge and its tombstone), the smallest
 * public id wins so the answer is stable.
 */
export const SELECT_HISTORY_WINDOW = `
SELECT d.detection_uid, d.source, d.acq_ts, d.lat::text AS lat, d.lon::text AS lon,
       d.frp_mw, ev.public_id
  FROM detections d
  LEFT JOIN LATERAL (
    SELECT f.public_id
      FROM clustering_runs r
      JOIN event_detections ed
        ON ed.clustering_run_id = r.id AND ed.detection_uid = d.detection_uid
       AND ed.acq_ts = d.acq_ts
      JOIN fire_events f
        ON f.id = ed.fire_event_id AND f.merged_into IS NULL AND NOT f.invalidated
     WHERE r.kind = 'live'
     ORDER BY f.public_id
     LIMIT 1
  ) ev ON true
 WHERE d.acq_ts >= $1::timestamptz AND d.acq_ts < $2::timestamptz
 ORDER BY d.acq_ts DESC, d.detection_uid DESC
 LIMIT $3`;

export function createPgHistoryReader(db: PgHistoryReadable): HistoryReader {
  return {
    async readHistory(fromMs, toMs, limit): Promise<readonly HistoryDetectionRow[]> {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('limit must be a positive safe integer');
      }
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
        throw new RangeError('the window must be finite and run forwards');
      }
      const { rows } = await db.query(SELECT_HISTORY_WINDOW, [
        new Date(fromMs).toISOString(),
        new Date(toMs).toISOString(),
        String(limit),
      ]);
      return rows.map(decodeRow);
    },
  };
}

function decodeRow(row: unknown): HistoryDetectionRow {
  const frp = field(row, 'frp_mw');
  const publicId = field(row, 'public_id');
  return {
    uid: string(field(row, 'detection_uid'), 'detection_uid'),
    sourceId: string(field(row, 'source'), 'source'),
    observedAt: epochMs(field(row, 'acq_ts'), 'acq_ts'),
    lat: number(Number(string(field(row, 'lat'), 'lat')), 'lat'),
    lon: number(Number(string(field(row, 'lon'), 'lon')), 'lon'),
    frpMw: frp === null ? null : number(frp, 'frp_mw'),
    eventPublicId: publicId === null ? null : string(publicId, 'public_id'),
  };
}
