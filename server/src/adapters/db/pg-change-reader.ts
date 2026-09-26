/**
 * The change read behind the stream pump (ADR-003 D1 T0, D3): every `fire_events` row whose
 * `seq` moved past a cursor, active or not.
 *
 * Same shape as the active-set statement and for the same reason — the mark and the rows
 * are one MVCC snapshot, so a `freshness` frame built from `max_seq` can never name a
 * change the ring does not hold. Unlike that statement there is no membership predicate:
 * the pump must see a row *leave* the map (tier change, merge, invalidation) to move its
 * cursor past it and to emit the `event.merged` tombstone. The survivor's public id comes
 * from a self-join on `merged_into` (a bigint foreign key to `fire_events.id`).
 *
 * `LIMIT` is the page size: the pump reads until a page comes back short, so a burst of
 * changes larger than one page costs more round trips, never a skipped row. Rows are
 * ordered by `seq`, which `fire_events_seq_uniq` makes a total order.
 */

import type { ChangeReader, ChangeRow, ChangesRead } from '../../core/ports/change-reader.js';
import { DISPLAY_TIERS, type DisplayTier } from '../../core/lifecycle/types.js';
import type { PgSnapshotReadable } from './pg-snapshot-reader.js';
import { boolean, decodeEvent, field, seqFrom, string } from './pg-rows.js';

export const SELECT_CHANGES = `
WITH bound AS (
  SELECT coalesce(max(seq), 0)::text AS max_seq FROM fire_events
),
changed AS (
  SELECT e.public_id, e.seq, e.status, e.score,
         ST_X(e.centroid) AS lon, ST_Y(e.centroid) AS lat,
         e.started_at, e.last_detection_at, e.detection_count, e.nearest_place,
         s.public_id AS merged_into, e.display_tier, e.invalidated
  FROM fire_events e
  LEFT JOIN fire_events s ON s.id = e.merged_into
  WHERE e.seq > $1::bigint
  ORDER BY e.seq
  LIMIT $2::int
)
SELECT bound.max_seq,
       changed.public_id, changed.seq::text AS seq, changed.status, changed.score,
       changed.lon, changed.lat, changed.started_at, changed.last_detection_at,
       changed.detection_count, changed.nearest_place,
       changed.merged_into, changed.display_tier, changed.invalidated
FROM bound LEFT JOIN changed ON true
ORDER BY changed.seq
`.trim();

export function createPgChangeReader(db: PgSnapshotReadable): ChangeReader {
  return {
    async readChangesSince(afterSeq: number, limit: number): Promise<ChangesRead> {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new RangeError('afterSeq must be a non-negative safe integer');
      }
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('limit must be a positive safe integer');
      }
      const { rows } = await db.query(SELECT_CHANGES, [String(afterSeq), limit]);
      const first = rows[0];
      if (first === undefined) throw new Error('change read returned no rows');
      const maxSeq = seqFrom(field(first, 'max_seq'), 'max_seq');
      const changes: ChangeRow[] = [];
      for (const row of rows) {
        const publicId = field(row, 'public_id');
        if (publicId === null) continue; // the no-change marker
        changes.push(decodeChange(row, string(publicId, 'public_id')));
      }
      return { maxSeq, rows: changes };
    },
  };
}

function decodeChange(row: unknown, publicId: string): ChangeRow {
  const mergedInto = field(row, 'merged_into');
  return {
    ...decodeEvent(row, publicId),
    mergedInto: mergedInto === null ? null : string(mergedInto, 'merged_into'),
    displayTier: displayTier(field(row, 'display_tier')),
    invalidated: boolean(field(row, 'invalidated'), 'invalidated'),
  };
}

function displayTier(value: unknown): DisplayTier {
  const text = string(value, 'display_tier');
  if (!(DISPLAY_TIERS as readonly string[]).includes(text)) {
    throw new Error(`fire_events.display_tier holds a value outside the tiers: ${text}`);
  }
  return text as DisplayTier;
}
