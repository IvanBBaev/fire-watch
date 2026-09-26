/**
 * Turns rows that changed into the frames the stream sends (ADR-003 D1 event types, D3
 * client rules).
 *
 * The projector is a fold over rows ordered by `seq`, carrying one piece of state: which
 * events the stream currently believes are on the map, and with which status. That map is
 * what lets one row become the right one of four frames:
 *
 *   * a tombstone (`merged_into` set) → `event.merged`, and the event leaves `known`;
 *   * a row that is no longer an active member (left the map tier, invalidated) → **no
 *     frame**, and the event leaves `known`. The client learns of removals only from a
 *     snapshot (D3 rule 5: "never delete on a delta"); the skipped `seq` leaves a hole in the
 *     ids, the client's gap rule (`id > max_seq + 1`) fires, and it fetches one. That is the
 *     one place the stream is *designed* to be incomplete, and it is what makes the ring's
 *     floor a number of its own rather than "oldest frame minus one";
 *   * a known member whose status changed → `event.status_changed` with `previous_status`;
 *   * a known member with the same status → `event.updated`;
 *   * a member the stream had not seen → `event.created`.
 *
 * The membership predicate below must agree with `SELECT_ACTIVE_SET` in the snapshot
 * reader, or a client could be told about an event the snapshot would not give it (and
 * would then never remove). A test pins the two together.
 *
 * Pure: rows in, frames out, no clock, no I/O.
 */

import type { LifecycleState } from '@fire-watch/contracts';

import type { ChangeRow } from '../ports/change-reader.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { ActiveSetRead } from '../ports/snapshot-reader.js';
import { eventFeature } from '../snapshot/snapshot-builder.js';
import type { EventFrame } from './frames.js';

/** Public id → status, for every event the stream believes is currently on the map. */
export type KnownEvents = ReadonlyMap<string, LifecycleState>;

export interface Projection {
  readonly frames: readonly EventFrame[];
  readonly known: KnownEvents;
}

/** Mirrors the `WHERE` of `SELECT_ACTIVE_SET`: on the map tier, not a tombstone, not voided. */
export function isActiveMember(row: ChangeRow): boolean {
  return row.displayTier === 'map' && row.mergedInto === null && !row.invalidated;
}

/** What the stream knows after seeding from a full active-set read. */
export function seedKnown(read: ActiveSetRead): KnownEvents {
  return new Map(read.events.map((event) => [event.publicId, event.status]));
}

export function projectChanges(
  known: KnownEvents,
  rows: readonly ChangeRow[],
  generatedAtMs: number,
): Projection {
  if (rows.length === 0) return { frames: [], known };
  const generatedAt = isoFromEpochMs(generatedAtMs);
  const next = new Map(known);
  const frames: EventFrame[] = [];
  for (const row of rows) {
    if (row.mergedInto !== null) {
      next.delete(row.publicId);
      frames.push({
        id: row.seq,
        event: 'event.merged',
        data: { generated_at: generatedAt, feature: eventFeature(row, row.mergedInto) },
      });
      continue;
    }
    if (!isActiveMember(row)) {
      next.delete(row.publicId);
      continue;
    }
    const previous = next.get(row.publicId);
    next.set(row.publicId, row.status);
    const feature = eventFeature(row, null);
    if (previous === undefined) {
      frames.push({
        id: row.seq,
        event: 'event.created',
        data: { generated_at: generatedAt, feature },
      });
    } else if (previous !== row.status) {
      frames.push({
        id: row.seq,
        event: 'event.status_changed',
        data: { generated_at: generatedAt, feature, previous_status: previous },
      });
    } else {
      frames.push({
        id: row.seq,
        event: 'event.updated',
        data: { generated_at: generatedAt, feature },
      });
    }
  }
  return { frames, known: next };
}
