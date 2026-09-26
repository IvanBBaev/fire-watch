/**
 * The active-set read behind `/snapshot.json` (ADR-003 D1, A1.4 R1, A1.5).
 *
 * ## One statement, one database snapshot
 *
 * The high-water mark and the members are read in a single statement on purpose. Read in
 * two, the mark can name a change the rows do not contain — the tick that landed between
 * them — and the client that stores that mark answers every later poll with `304`, forever
 * missing the event that changed. A single statement sees one MVCC snapshot whatever the
 * isolation level, so the mark and the rows agree by construction.
 *
 * ## What "active" means here
 *
 * The predicate is the projection column migration 004 introduced, not the wall clock:
 * `display_tier = 'map'`, not tombstoned, not invalidated. The lifecycle job decides when an
 * event leaves the map and writes that decision with a `seq` bump; this module only reads it
 * back. There is no `now()` and no interval arithmetic below, which is what makes "every
 * removal changes the ETag" a property of the schema rather than a hope.
 *
 * ## Where the mark can still lag
 *
 * `seq` is a sequence, not a commit timestamp: a transaction that drew `seq = 100` can commit
 * after one that drew `101` was read. The lifecycle job is the only writer of `fire_events`
 * and runs its transitions serially, so the window does not exist today; a second concurrent
 * writer would need the mark bounded by `pg_current_snapshot()` instead. Noted, not built.
 */

import type {
  ActiveEventRow,
  ActiveSetRead,
  SnapshotReader,
  SourceObservationRow,
} from '../../core/ports/snapshot-reader.js';
import { decodeEvent, epochMs, field, seqFrom, string } from './pg-rows.js';

/**
 * The slice of `pg` this module uses. Rows come back untyped because two statement shapes
 * share one client and every value the driver hands over is checked below anyway — `bigint`
 * arrives as a string, `jsonb` as whatever was stored.
 */
export interface PgSnapshotReadable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

/**
 * `bound` is the mark over the *whole* registry — a removed event bumps its own `seq`, so
 * the mark moves although no active row carries it. `LEFT JOIN ... ON true` keeps the mark
 * row when the set is empty or nothing is above the cursor: the caller then gets exactly
 * one row whose member columns are null. `centroid` is `geometry(Point, 4326)`, so `ST_X`
 * is longitude and `ST_Y` latitude, in that order.
 */
export const SELECT_ACTIVE_SET = `
WITH bound AS (
  SELECT coalesce(max(seq), 0)::text AS max_seq FROM fire_events
),
members AS (
  SELECT public_id, seq, status, score,
         ST_X(centroid) AS lon, ST_Y(centroid) AS lat,
         started_at, last_detection_at, detection_count, nearest_place
  FROM fire_events
  WHERE display_tier = 'map' AND merged_into IS NULL AND NOT invalidated
    AND seq > $1::bigint
)
SELECT bound.max_seq,
       members.public_id, members.seq::text AS seq, members.status, members.score,
       members.lon, members.lat, members.started_at, members.last_detection_at,
       members.detection_count, members.nearest_place
FROM bound LEFT JOIN members ON true
ORDER BY members.seq
`.trim();

/**
 * One row per requested id, in request order, whether or not the source has ever delivered:
 * `unnest ... WITH ORDINALITY` is the driving table and the newest detection is looked up
 * per source on `detections_source_acq_ts`. `acq_ts` is the satellite observation time (D2:
 * per-source freshness is when the data was *observed*, never when we last polled).
 */
export const SELECT_SOURCE_OBSERVATIONS = `
SELECT s.source, d.acq_ts
FROM unnest($1::text[]) WITH ORDINALITY AS s(source, ord)
LEFT JOIN LATERAL (
  SELECT acq_ts FROM detections WHERE source = s.source ORDER BY acq_ts DESC LIMIT 1
) d ON true
ORDER BY s.ord
`.trim();

export function createPgSnapshotReader(db: PgSnapshotReadable): SnapshotReader {
  return {
    async readActiveSet(afterSeq: number): Promise<ActiveSetRead> {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new RangeError('afterSeq must be a non-negative safe integer');
      }
      const { rows } = await db.query(SELECT_ACTIVE_SET, [String(afterSeq)]);
      const first = rows[0];
      if (first === undefined) throw new Error('active-set read returned no rows');
      const maxSeq = seqFrom(field(first, 'max_seq'), 'max_seq');
      const events: ActiveEventRow[] = [];
      for (const row of rows) {
        const publicId = field(row, 'public_id');
        if (publicId === null) continue; // the empty-set marker
        events.push(decodeEvent(row, string(publicId, 'public_id')));
      }
      return { maxSeq, events };
    },

    async readSourceObservations(
      sourceIds: readonly string[],
    ): Promise<readonly SourceObservationRow[]> {
      if (sourceIds.length === 0) return [];
      const { rows } = await db.query(SELECT_SOURCE_OBSERVATIONS, [sourceIds]);
      return rows.map((row) => {
        const acqTs = field(row, 'acq_ts');
        return {
          sourceId: string(field(row, 'source'), 'source'),
          lastObservedAt: acqTs === null ? null : epochMs(acqTs, 'acq_ts'),
        };
      });
    },
  };
}
