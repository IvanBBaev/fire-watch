/**
 * The live alert evaluation loop's transaction over Postgres (ADR-004 D1; TASKS H3).
 *
 * One {@link AlertEvaluationStore.withTransaction} is one batch: a client is checked out,
 * `BEGIN`, the identity pipeline is fenced off (below), and every store the core touches —
 * watch zones, alert states, the outbox, the event read, the cursor — is built over *that*
 * client. `COMMIT` or `ROLLBACK`; `ROLLBACK`'s own failure is swallowed so the original
 * error surfaces, and the client is released on every path (the `pg-zone-creation.ts`
 * shape).
 *
 * ## Why the cursor cannot skip a row
 *
 * `fire_events.seq` is drawn from a sequence at write time and becomes visible at commit
 * time, so a reader that simply took `seq > cursor` could see seq 12 commit before seq 11
 * and move its cursor past 11 forever. Every writer of `fire_events` — the clustering
 * batch and the lifecycle tick, and the status store that runs inside the tick — holds
 * `SELECT … FROM clustering_runs … FOR UPDATE` on its run for the whole of its
 * transaction. This transaction takes `FOR SHARE` on every run row first, which waits for
 * each such writer to finish and blocks new ones until this batch commits. Under READ
 * COMMITTED every statement after the lock sees all of their committed rows, and none of
 * theirs is in flight. The cost is that the identity pipeline waits for one alert batch;
 * the batch is bounded by its page size.
 *
 * The same fence orders this loop against the merge and reignition folds of `alert_states`,
 * which run inside the clustering transaction: a fold can never interleave with a batch
 * that has read the pre-fold rows.
 *
 * ## The cursor and the marks
 *
 * Migration 009. The cursor row is created on first advance and only ever moves forward
 * (`WHERE last_seq <= $1`); an advance that would move it backwards throws, because it
 * would mean two loops are running, which the fence does not prevent between two alert
 * batches (FOR SHARE is compatible with itself).
 */

import type {
  AlertEvaluationStore,
  AlertEvaluationTransaction,
  EvaluatedEventMark,
  EvaluationEventRow,
} from '../../core/ports/alert-evaluation-store.js';
import { createPgAlertDecisionLog } from './pg-alert-decision-log.js';
import { createPgAlertOutboxStore } from './pg-alert-outbox-store.js';
import { createPgAlertStateStore } from './pg-alert-state-store.js';
import {
  ALERTABLE_EVENT_COLUMNS,
  ALERTABLE_EVENT_JOINS,
  decodeEvaluationEventRow,
} from './pg-alertable-events.js';
import { createPgWatchZoneStore } from './pg-watch-zone-store.js';
import { field, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgAlertEvaluationQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgAlertEvaluationClient extends PgAlertEvaluationQueryable {
  release(): void;
}

export interface PgAlertEvaluationPool {
  connect(): Promise<PgAlertEvaluationClient>;
}

/** Waits out every in-flight `fire_events` writer and holds new ones off until COMMIT. */
const FENCE_IDENTITY_WRITERS = `
SELECT id FROM clustering_runs ORDER BY id FOR SHARE`.trim();

const SELECT_CURSOR = `
SELECT last_seq::text AS last_seq FROM alert_evaluation_cursor WHERE id = 1`.trim();

const SELECT_EVENTS_AFTER = `
SELECT ${ALERTABLE_EVENT_COLUMNS}
FROM fire_events e
${ALERTABLE_EVENT_JOINS}
WHERE e.seq > $1::bigint
ORDER BY e.seq
LIMIT $2::int`.trim();

const UPSERT_EVALUATED = `
INSERT INTO alert_evaluated_events (fire_event_id, last_status, last_seq, evaluated_at)
SELECT m.fire_event_id, m.last_status, m.last_seq, $4::timestamptz
FROM unnest($1::bigint[], $2::text[], $3::bigint[]) AS m(fire_event_id, last_status, last_seq)
ON CONFLICT (fire_event_id) DO UPDATE
   SET last_status = EXCLUDED.last_status,
       last_seq = EXCLUDED.last_seq,
       evaluated_at = EXCLUDED.evaluated_at
 WHERE alert_evaluated_events.last_seq <= EXCLUDED.last_seq`.trim();

const ADVANCE_CURSOR = `
INSERT INTO alert_evaluation_cursor (id, last_seq, updated_at)
VALUES (1, $1::bigint, $2::timestamptz)
ON CONFLICT (id) DO UPDATE
   SET last_seq = EXCLUDED.last_seq, updated_at = EXCLUDED.updated_at
 WHERE alert_evaluation_cursor.last_seq <= EXCLUDED.last_seq`.trim();

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ALERT_EVALUATION_SQL = Object.freeze({
  fence: FENCE_IDENTITY_WRITERS,
  selectCursor: SELECT_CURSOR,
  selectEventsAfter: SELECT_EVENTS_AFTER,
  upsertEvaluated: UPSERT_EVALUATED,
  advanceCursor: ADVANCE_CURSOR,
});

/** The transaction's reads and writes over one already-`BEGIN`-ed client. */
export function alertEvaluationTransactionOver(
  client: PgAlertEvaluationQueryable,
): AlertEvaluationTransaction {
  return {
    async readCursor(): Promise<string> {
      const result = await client.query(SELECT_CURSOR);
      const [row] = result.rows;
      return row === undefined ? '0' : string(field(row, 'last_seq'), 'last_seq');
    },

    async readEventsAfter(afterSeq, limit): Promise<readonly EvaluationEventRow[]> {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError(`limit must be a positive integer, got ${String(limit)}`);
      }
      const result = await client.query(SELECT_EVENTS_AFTER, [afterSeq, limit]);
      return result.rows.map(decodeEvaluationEventRow);
    },

    zones: createPgWatchZoneStore(client),
    alertStates: createPgAlertStateStore(client),
    outbox: createPgAlertOutboxStore(client),
    decisionLog: createPgAlertDecisionLog(client),

    async recordEvaluated(marks: readonly EvaluatedEventMark[], atIso): Promise<void> {
      if (marks.length === 0) return;
      await client.query(UPSERT_EVALUATED, evaluatedArrays(marks, atIso));
    },

    async advanceCursor(seq, atIso): Promise<void> {
      const result = await client.query(ADVANCE_CURSOR, [seq, atIso]);
      if (result.rowCount !== 1) {
        throw new Error(`alert evaluation cursor refused to move back to ${seq}`);
      }
    },
  };
}

/** The bound values of {@link UPSERT_EVALUATED}, in order. */
export function evaluatedArrays(
  marks: readonly EvaluatedEventMark[],
  atIso: string,
): readonly unknown[] {
  return [
    marks.map((m) => m.fireEventId),
    marks.map((m) => m.status),
    marks.map((m) => m.seq),
    atIso,
  ];
}

export function createPgAlertEvaluationStore(pool: PgAlertEvaluationPool): AlertEvaluationStore {
  return {
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(FENCE_IDENTITY_WRITERS);
        const result = await work(alertEvaluationTransactionOver(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
