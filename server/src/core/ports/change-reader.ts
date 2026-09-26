/**
 * The read behind the stream pump: every `fire_events` row whose `seq` moved past a cursor,
 * whether or not it is still on the map.
 *
 * `SnapshotReader.readActiveSet` deliberately filters to the active set — a snapshot is the
 * set. The stream needs the complement too: a row that just left the map (its tier changed,
 * it was merged, it was invalidated) bumps `seq` like any other change, and the pump has to
 * *see* it to know the cursor moved past it, even when it decides not to emit a frame for
 * it. Hence a second port with the same row shape plus the three projection columns that
 * decide membership.
 */

import type { DisplayTier } from '../lifecycle/types.js';
import type { ActiveEventRow } from './snapshot-reader.js';

export interface ChangeRow extends ActiveEventRow {
  /** The public id of the surviving event when this one is a tombstone, else null. */
  readonly mergedInto: string | null;
  readonly displayTier: DisplayTier;
  readonly invalidated: boolean;
}

export interface ChangesRead {
  /** The high-water mark over the whole registry at the instant of the read. */
  readonly maxSeq: number;
  /** Rows with `seq > afterSeq`, ascending by `seq`, at most `limit` of them. */
  readonly rows: readonly ChangeRow[];
}

export interface ChangeReader {
  readChangesSince(afterSeq: number, limit: number): Promise<ChangesRead>;
}
