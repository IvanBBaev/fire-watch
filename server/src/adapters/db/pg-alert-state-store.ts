/**
 * The per-`(zone, event)` state machine over Postgres (ADR-004 D3 as amended by
 * A1.8/A1.11).
 *
 * Five statements, no transaction of its own. D1 requires the state change and the outbox
 * row it produced to be atomic, and the outbox lives behind another port, so — exactly as
 * `pg-alert-outbox-store.ts` does — the caller hands both stores whichever handle it has
 * already put a `BEGIN` on. Handing this module a `Pool` is legal and gives each statement
 * its own implicit transaction; handing it a client mid-transaction is what D1 asks for,
 * and is the only way the port's own "read inside the transaction, or the seed is lost"
 * rule can hold.
 *
 * ## Why this adapter translates public ids and the outbox does not
 *
 * `alert_states.fire_event_id` is the internal `bigint`, and `OutboxRowDraft.fireEventId`
 * is that same bigint as decimal text — the outbox port pushes the translation onto its
 * caller because an outbox row also carries `trigger_ref_seq`, so a caller that has read
 * `fire_events.seq` has the internal row in its hand already. Nothing of the sort is true
 * here: `AlertStateRow` is a *core* type, produced by `decideAlert` and folded by
 * `foldAlertStates`, and both speak `fw-YYYY-xxxxx` because A2.1 makes the public id the
 * identity permalinks and users are built on. Making the core carry an internal id so this
 * adapter could skip a lookup on a unique btree index would be paying in the wrong
 * currency.
 *
 * So every statement joins `fire_events` on `public_id`, and the write joins it **LEFT**.
 * That is not a courtesy to unknown ids — it is how an unknown id is made to fail *without
 * writing anything*: the unmatched row's `fire_event_id` comes out `NULL`, the column is
 * `NOT NULL`, and Postgres rejects the whole statement. An inner join would have dropped
 * that pair silently and returned a short count, and a silently dropped state row is the
 * pair that gets told "new fire" about a fire it has been following all week.
 */

import type { AlertStateStore } from '../../core/ports/alert-state-store.js';
import {
  ALERT_STATES,
  type AlertState,
  type AlertStateKey,
  type AlertStateRow,
} from '../../core/registry/alert-state.js';

/**
 * The slice of `pg` this module uses. Wider than the outbox's, because this store reads:
 * it needs the rows as well as the count, and it asks for more than one row shape.
 */
export interface PgAlertStateQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** One `alert_states` row joined to its event's public id, as the driver hands it over. */
interface StoredStateRow extends Record<string, unknown> {
  readonly watch_zone_id: string;
  readonly public_id: string;
  readonly state: string;
  readonly escalation_watermark: number;
  readonly seeded_at: Date | null;
  readonly last_notified_at: Date | null;
}

interface ZoneLastNotifiedRow extends Record<string, unknown> {
  readonly watch_zone_id: string;
  readonly last_notified_at: Date;
}

const STATE_PROJECTION =
  's.watch_zone_id, e.public_id, s.state, s.escalation_watermark, s.seeded_at, s.last_notified_at';

/**
 * `unnest` of two arrays rather than an `IN` list built per call: two parameters whatever
 * the batch size, so an August afternoon evaluating several thousand pairs meets the same
 * prepared statement as a quiet Tuesday and never approaches the 65,535-parameter wire
 * limit.
 */
const SELECT_STATES = `
SELECT ${STATE_PROJECTION}
FROM unnest($1::uuid[], $2::text[]) AS wanted(zone_id, public_id)
JOIN fire_events e ON e.public_id = wanted.public_id
JOIN alert_states s ON s.watch_zone_id = wanted.zone_id AND s.fire_event_id = e.id
`.trim();

const SELECT_STATES_FOR_EVENTS = `
SELECT ${STATE_PROJECTION}
FROM fire_events e
JOIN alert_states s ON s.fire_event_id = e.id
WHERE e.public_id = ANY($1::text[])
`.trim();

/**
 * The cross-event half of D3's suppression window, as an aggregate over this table rather
 * than a denormalized column on `watch_zones`. `alert_states_by_event` does not serve this
 * one; the primary key's leading `watch_zone_id` does, and a zone holds one row per fire it
 * watches, which is tens, not thousands.
 */
const SELECT_ZONE_LAST_NOTIFIED = `
SELECT watch_zone_id, max(last_notified_at) AS last_notified_at
FROM alert_states
WHERE watch_zone_id = ANY($1::uuid[]) AND last_notified_at IS NOT NULL
GROUP BY watch_zone_id
`.trim();

/**
 * Whole rows, never deltas: `state`, `escalation_watermark`, `seeded_at` and
 * `last_notified_at` are written together from what the decision returned, which is what
 * makes replaying a decision produce exactly the row that decision describes.
 *
 * `updated_at` is set explicitly because the column's `DEFAULT now()` covers the insert and
 * not the `DO UPDATE`, and a bookkeeping timestamp that stops moving on the writes that
 * matter is worse than no column at all. `now()` is transaction start, so one batch stamps
 * one instant — and it is a clock read the *adapter* is allowed and the core is not.
 */
const UPSERT_STATES = `
INSERT INTO alert_states (
  watch_zone_id, fire_event_id, state, escalation_watermark, seeded_at, last_notified_at,
  updated_at
)
SELECT batch.zone_id, e.id, batch.state, batch.watermark, batch.seeded_at,
       batch.last_notified_at, now()
FROM unnest($1::uuid[], $2::text[], $3::text[], $4::integer[], $5::timestamptz[],
            $6::timestamptz[])
  AS batch(zone_id, public_id, state, watermark, seeded_at, last_notified_at)
LEFT JOIN fire_events e ON e.public_id = batch.public_id
ON CONFLICT (watch_zone_id, fire_event_id) DO UPDATE SET
  state = EXCLUDED.state,
  escalation_watermark = EXCLUDED.escalation_watermark,
  seeded_at = EXCLUDED.seeded_at,
  last_notified_at = EXCLUDED.last_notified_at,
  updated_at = EXCLUDED.updated_at
`.trim();

/**
 * Absent keys are not an error, so this one joins inner: the merge migration is replayable
 * and a re-run has already deleted what it names. An unknown public id therefore removes
 * nothing and says so through the count, which is the opposite of the write's rule for the
 * opposite reason — deleting nothing is safe, failing to write a row is not.
 */
const DELETE_STATES = `
DELETE FROM alert_states s
USING unnest($1::uuid[], $2::text[]) AS wanted(zone_id, public_id), fire_events e
WHERE e.public_id = wanted.public_id
  AND s.watch_zone_id = wanted.zone_id
  AND s.fire_event_id = e.id
`.trim();

export function createPgAlertStateStore(db: PgAlertStateQueryable): AlertStateStore {
  return {
    async loadStates(keys: readonly AlertStateKey[]): Promise<readonly AlertStateRow[]> {
      if (keys.length === 0) return [];
      const { rows } = await db.query<StoredStateRow>(SELECT_STATES, [
        keys.map((key) => key.zoneId),
        keys.map((key) => key.eventPublicId),
      ]);
      return rows.map(toAlertStateRow);
    },

    async loadStatesForEvents(
      eventPublicIds: readonly string[],
    ): Promise<readonly AlertStateRow[]> {
      if (eventPublicIds.length === 0) return [];
      const { rows } = await db.query<StoredStateRow>(SELECT_STATES_FOR_EVENTS, [
        [...eventPublicIds],
      ]);
      return rows.map(toAlertStateRow);
    },

    async lastNotifiedByZone(zoneIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
      if (zoneIds.length === 0) return new Map();
      const { rows } = await db.query<ZoneLastNotifiedRow>(SELECT_ZONE_LAST_NOTIFIED, [
        [...zoneIds],
      ]);
      // A zone that has never sent anything is absent rather than present with a null:
      // `null` and "no entry" would be two spellings of one fact, and the decision reads
      // this through `?? null` either way.
      return new Map(rows.map((row) => [row.watch_zone_id, row.last_notified_at.toISOString()]));
    },

    async upsert(rows: readonly AlertStateRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      assertOnePairEach(rows);
      const result = await db.query(UPSERT_STATES, upsertArrays(rows));
      return result.rowCount ?? 0;
    },

    async remove(keys: readonly AlertStateKey[]): Promise<number> {
      if (keys.length === 0) return 0;
      const result = await db.query(DELETE_STATES, [
        keys.map((key) => key.zoneId),
        keys.map((key) => key.eventPublicId),
      ]);
      return result.rowCount ?? 0;
    },
  };
}

/** One array per `unnest` column, in the order {@link UPSERT_STATES} names them. */
export function upsertArrays(rows: readonly AlertStateRow[]): readonly unknown[][] {
  return [
    rows.map((row) => row.zoneId),
    rows.map((row) => row.eventPublicId),
    rows.map((row) => row.state),
    rows.map((row) => row.escalationWatermark),
    rows.map((row) => row.seededAtIso),
    rows.map((row) => row.lastNotifiedAtIso),
  ];
}

/**
 * A batch names each pair at most once.
 *
 * Postgres would refuse the second row anyway — `ON CONFLICT DO UPDATE` cannot affect the
 * same row twice in one command — but it would refuse it as a cardinality error nobody can
 * read. Two rows for one pair means the fold was skipped, or two zones' decisions were
 * concatenated without being reduced, and saying so is worth one pass over the batch.
 */
function assertOnePairEach(rows: readonly AlertStateRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const pair = `${row.zoneId} ${row.eventPublicId}`;
    if (seen.has(pair)) {
      throw new RangeError(
        `two alert states for zone ${row.zoneId} and event ${row.eventPublicId} in one batch; ` +
          'fold them before writing',
      );
    }
    seen.add(pair);
  }
}

function toAlertStateRow(row: StoredStateRow): AlertStateRow {
  return {
    zoneId: row.watch_zone_id,
    eventPublicId: row.public_id,
    state: toAlertState(row.state),
    escalationWatermark: row.escalation_watermark,
    seededAtIso: row.seeded_at?.toISOString() ?? null,
    lastNotifiedAtIso: row.last_notified_at?.toISOString() ?? null,
  };
}

/**
 * The column's CHECK constraint holds the same four values, so this can only fire once the
 * constraint has been widened and {@link ALERT_STATES} has not — which is the one moment
 * reading it as an `AlertState` would be a lie the whole ladder is then computed from.
 */
function toAlertState(value: string): AlertState {
  const state = ALERT_STATES.find((candidate) => candidate === value);
  if (state === undefined) {
    throw new RangeError(`alert_states.state holds ${JSON.stringify(value)}, which is not a state`);
  }
  return state;
}

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ALERT_STATE_SQL = Object.freeze({
  selectStates: SELECT_STATES,
  selectStatesForEvents: SELECT_STATES_FOR_EVENTS,
  selectZoneLastNotified: SELECT_ZONE_LAST_NOTIFIED,
  upsertStates: UPSERT_STATES,
  deleteStates: DELETE_STATES,
});
