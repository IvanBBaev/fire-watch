/**
 * {@link MetaAlertStateStore} over Postgres (TASKS J1; migration 036).
 *
 * One transaction per cycle: take `pg_advisory_xact_lock(7036, 0)`, read every row, let the
 * core decide, upsert what it returns, commit. The lock is transaction-scoped (released by
 * COMMIT or ROLLBACK, never leaked by a crashed cycle) and covers keys that have no row yet,
 * which a `SELECT … FOR UPDATE` could not. `decide` is synchronous, so the lock is held for
 * two statements' worth of time.
 *
 * The write is one statement over `unnest` arrays — eight keys today, one round trip.
 */

import type { MetaAlertState } from '../../core/monitoring/meta-alert-evaluator.js';
import type {
  StoredMetaAlertState,
  StoredMetaAlertStates,
} from '../../core/monitoring/meta-alert-memory.js';
import { isoFromEpochMs } from '../../core/ports/clock.js';
import type {
  MetaAlertStateDecision,
  MetaAlertStateStore,
} from '../../core/ports/meta-alert-state-store.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';

/** Migration number, like 7007/7012/7020/7035: one class per guarded purpose. */
export const META_ALERT_STATE_LOCK_CLASS = 7036;

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgMetaAlertStateQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgMetaAlertStateClient extends PgMetaAlertStateQueryable {
  release(): void;
}

export interface PgMetaAlertStatePool {
  connect(): Promise<PgMetaAlertStateClient>;
}

const LOCK = `SELECT pg_advisory_xact_lock(${String(META_ALERT_STATE_LOCK_CLASS)}, 0)`;

const SELECT_STATES = `
SELECT key, paging, paging_since, breach_streak, clear_streak, evaluated_at
FROM meta_alert_states`;

const UPSERT_STATES = `
INSERT INTO meta_alert_states
  (key, paging, paging_since, breach_streak, clear_streak, evaluated_at)
SELECT * FROM unnest(
  $1::text[], $2::boolean[], $3::timestamptz[], $4::integer[], $5::integer[], $6::timestamptz[]
)
ON CONFLICT (key) DO UPDATE SET
  paging = EXCLUDED.paging,
  paging_since = EXCLUDED.paging_since,
  breach_streak = EXCLUDED.breach_streak,
  clear_streak = EXCLUDED.clear_streak,
  evaluated_at = EXCLUDED.evaluated_at`;

export const META_ALERT_STATE_SQL = {
  lock: LOCK,
  select: SELECT_STATES,
  upsert: UPSERT_STATES,
} as const;

export function createPgMetaAlertStateStore(pool: PgMetaAlertStatePool): MetaAlertStateStore {
  return {
    async update<T>(
      decide: (stored: StoredMetaAlertStates) => MetaAlertStateDecision<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(LOCK);
        const { rows } = await client.query(SELECT_STATES);
        const decision = decide(decodeRows(rows));
        if (decision.write !== null && decision.write.size > 0) {
          await client.query(UPSERT_STATES, upsertValues(decision.write));
        }
        await client.query('COMMIT');
        return decision.result;
      } catch (error) {
        // ROLLBACK's own failure never masks the original (same shape as pg-auth.ts).
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function decodeRows(rows: readonly unknown[]): StoredMetaAlertStates {
  const stored = new Map<string, StoredMetaAlertState>();
  for (const row of rows) {
    const paging = boolean(field(row, 'paging'), 'paging');
    const since = field(row, 'paging_since');
    const state: MetaAlertState = {
      paging,
      breachStreak: number(field(row, 'breach_streak'), 'breach_streak'),
      clearStreak: number(field(row, 'clear_streak'), 'clear_streak'),
      pagingSince: since === null ? null : epochMs(since, 'paging_since'),
    };
    stored.set(string(field(row, 'key'), 'key'), {
      state,
      evaluatedAt: epochMs(field(row, 'evaluated_at'), 'evaluated_at'),
    });
  }
  return stored;
}

function upsertValues(write: ReadonlyMap<string, StoredMetaAlertState>): unknown[] {
  const entries = [...write];
  return [
    entries.map(([key]) => key),
    entries.map(([, s]) => s.state.paging),
    entries.map(([, s]) =>
      s.state.pagingSince === null ? null : isoFromEpochMs(s.state.pagingSince),
    ),
    entries.map(([, s]) => s.state.breachStreak),
    entries.map(([, s]) => s.state.clearStreak),
    entries.map(([, s]) => isoFromEpochMs(s.evaluatedAt)),
  ];
}
