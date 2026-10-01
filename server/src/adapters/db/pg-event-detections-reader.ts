/**
 * The per-event detections read (`EventDetectionsReader`) against Postgres.
 *
 * Two statements, in an order that makes their lack of a shared snapshot harmless: the
 * event row — and with it the `seq` the route derives its ETag from — is read **first**,
 * the members second. Under READ COMMITTED the second statement sees at least everything
 * the first did, so a body can only ever be newer than its tag, never older. A newer body
 * under an older tag costs one extra 200 on the next poll (the tag has moved by then);
 * the reverse would be a 304 hiding a change forever. Attaching a detection bumps the
 * event's `seq` (migration 004: `detection_count` and `last_detection_at` are projected),
 * which is what lets one integer stand for the member list.
 */

import type {
  EventDetectionRow,
  EventDetectionsRead,
  EventDetectionsReader,
} from '../../core/ports/event-detections-reader.js';
import { epochMs, field, number, seqFrom, string } from './pg-rows.js';

/** The slice of `pg` this adapter needs; a `Pool` and a `Client` both satisfy it. */
export interface PgEventDetectionsReadable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

/**
 * A merge chain longer than this is a corrupt registry, not a history: merges collapse
 * onto the survivor, so real chains are one or two links. The bound turns a cycle —
 * which the schema cannot rule out across rows — into an error instead of a hung query.
 */
export const MAX_MERGE_CHAIN = 32;

/**
 * The requested row, then each `merged_into` hop, in order. Read-only: no path
 * compression here, that is the merge writer's business.
 */
export const SELECT_EVENT_CHAIN = `
WITH RECURSIVE chain AS (
  SELECT id, public_id, seq, merged_into, 0 AS depth
    FROM fire_events
   WHERE public_id = $1
  UNION ALL
  SELECT f.id, f.public_id, f.seq, f.merged_into, c.depth + 1
    FROM fire_events f
    JOIN chain c ON f.id = c.merged_into
   WHERE c.depth < ${String(MAX_MERGE_CHAIN)}
)
SELECT id::text AS id, public_id, seq::text AS seq, merged_into::text AS merged_into, depth
  FROM chain
 ORDER BY depth`;

/**
 * The newest `$2` distinct live members, then their detection rows, newest first (the
 * adapter drops the probe row past the limit, then reverses to oldest first). The
 * limit is applied to the membership index (`event_detections_by_event`) before any
 * partition of `detections` is touched, so a very large event costs `$2` primary-key
 * lookups, not a scan. The same detection can be attached by several live runs; DISTINCT
 * collapses those. Coordinates travel as text so the hashed 5-dp decimals are not first
 * widened to a double by the driver's float parser.
 */
export const SELECT_EVENT_MEMBERS = `
SELECT d.detection_uid, d.source, d.acq_ts, d.lat::text AS lat, d.lon::text AS lon,
       d.confidence, d.scan_km, d.track_km, d.frp_mw
  FROM (
    SELECT DISTINCT ed.acq_ts, ed.detection_uid
      FROM event_detections ed
      JOIN clustering_runs r ON r.id = ed.clustering_run_id AND r.kind = 'live'
     WHERE ed.fire_event_id = $1
     ORDER BY ed.acq_ts DESC, ed.detection_uid DESC
     LIMIT $2
  ) m
  JOIN detections d ON d.acq_ts = m.acq_ts AND d.detection_uid = m.detection_uid
 ORDER BY d.acq_ts DESC, d.detection_uid DESC`;

export function createPgEventDetectionsReader(
  db: PgEventDetectionsReadable,
): EventDetectionsReader {
  return {
    async readEventDetections(publicId: string, limit: number): Promise<EventDetectionsRead> {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('limit must be a positive safe integer');
      }
      const { rows: chain } = await db.query(SELECT_EVENT_CHAIN, [publicId]);
      const requested = chain[0];
      if (requested === undefined) return { kind: 'unknown' };
      const last = chain[chain.length - 1];
      if (field(last, 'merged_into') !== null) {
        throw new Error(`merge chain does not end within ${String(MAX_MERGE_CHAIN)} hops`);
      }
      const seq = seqFrom(field(requested, 'seq'), 'seq');
      if (chain.length > 1) {
        return {
          kind: 'merged',
          seq,
          survivorPublicId: string(field(last, 'public_id'), 'public_id'),
          survivorSeq: seqFrom(field(last, 'seq'), 'seq'),
        };
      }

      // One row past the limit tells "exactly `limit`" from "more than `limit`".
      const { rows } = await db.query(SELECT_EVENT_MEMBERS, [
        field(requested, 'id'),
        String(limit + 1),
      ]);
      const truncated = rows.length > limit;
      const detections = rows.slice(0, limit).map(decodeDetection).reverse();
      return { kind: 'event', seq, detections, truncated };
    },
  };
}

function decodeDetection(row: unknown): EventDetectionRow {
  const confidence = string(field(row, 'confidence'), 'confidence');
  if (confidence !== 'low' && confidence !== 'nominal' && confidence !== 'high') {
    throw new Error(`detections.confidence holds an unknown value: ${confidence}`);
  }
  return {
    uid: string(field(row, 'detection_uid'), 'detection_uid'),
    sourceId: string(field(row, 'source'), 'source'),
    observedAt: epochMs(field(row, 'acq_ts'), 'acq_ts'),
    lat: decimal(field(row, 'lat'), 'lat'),
    lon: decimal(field(row, 'lon'), 'lon'),
    confidence,
    scanKm: optionalNumber(field(row, 'scan_km'), 'scan_km'),
    trackKm: optionalNumber(field(row, 'track_km'), 'track_km'),
    frpMw: optionalNumber(field(row, 'frp_mw'), 'frp_mw'),
  };
}

function decimal(value: unknown, name: string): number {
  return number(Number(string(value, name)), name);
}

function optionalNumber(value: unknown, name: string): number | null {
  return value === null ? null : number(value, name);
}
