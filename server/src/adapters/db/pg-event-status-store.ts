/**
 * The one statement that moves an event between lifecycle states (ADR-003 A1.4 R1).
 *
 * The write sets the status, its reason and instant, the display tier and the inactivity
 * anchor together, and draws the next `seq` in the same row — migration 001 makes the
 * default apply on insert only, so a transition that forgot the bump would leave the
 * snapshot ETag standing on a set that changed. Migration 004's trigger would catch that
 * too, but the backstop is for writers that forget, not a licence to.
 *
 * `merged_into IS NULL` keeps a tombstone where it is: a merged event's public id still
 * resolves (per-id lookups redirect through it) but it has no lifecycle of its own any more,
 * so a job that tries to transition one gets `null` and can log the stale reference.
 */

import type {
  EventStatusStore,
  EventStatusTransition,
} from '../../core/ports/event-status-store.js';

export interface PgEventStatusWritable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

export const UPDATE_EVENT_STATUS = `
UPDATE fire_events
   SET status = $2,
       status_reason = $3,
       status_changed_at = $4,
       display_tier = $5,
       inactive_since = $6,
       seq = nextval('fire_events_seq_seq'),
       updated_at = now()
 WHERE public_id = $1 AND merged_into IS NULL
RETURNING seq::text AS seq
`.trim();

export function createPgEventStatusStore(db: PgEventStatusWritable): EventStatusStore {
  return {
    async applyTransition(transition: EventStatusTransition): Promise<number | null> {
      const { rows } = await db.query(UPDATE_EVENT_STATUS, [
        transition.publicId,
        transition.status,
        transition.statusReason,
        new Date(transition.atMs),
        transition.displayTier,
        transition.inactiveSinceMs === null ? null : new Date(transition.inactiveSinceMs),
      ]);
      const row = rows[0];
      if (row === undefined) return null;
      const seq = (row as Record<string, unknown>)['seq'];
      if (typeof seq !== 'string' || !/^\d+$/.test(seq) || !Number.isSafeInteger(Number(seq))) {
        throw new Error('transition returned no usable seq');
      }
      return Number(seq);
    },
  };
}
