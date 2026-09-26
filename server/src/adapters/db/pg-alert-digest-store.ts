/**
 * The live digest pass's transaction over Postgres (ADR-004 D1, D3, A1.7, A1.8, A1.11,
 * A1.12; TASKS H3/D9; migration 018).
 *
 * One {@link AlertDigestStore.withAccount} is one account's digest decision: a client is
 * checked out, `BEGIN`, and every read and write the core makes — the account lock, the
 * zones, the watermark, the pairs, the log and the outbox — goes through *that* client.
 * `COMMIT` or `ROLLBACK`; `ROLLBACK`'s own failure is swallowed so the original error
 * surfaces, and the client is released on every path (the `pg-alert-evaluation-store.ts`
 * shape).
 *
 * ## The account lock
 *
 * `lockAccount` reads the account `FOR SHARE` and only while `deleted_at IS NULL`. Erasure
 * (`pg-account-erasure.ts`) takes the same row `FOR UPDATE` first, so the two serialize:
 * a pass that locked first commits its log and outbox rows before erasure reads the zones
 * (and they go with them); an erasure that locked first makes this read wait, re-check the
 * row after the erasure commits, and find it tombstoned — the pass then writes nothing.
 * Two passes on one account both hold `FOR SHARE` (compatible); migration 018's unique key
 * is what orders them. `FOR SHARE` needs UPDATE on the table, which the runtime role holds
 * on `accounts` (the integration test runs this as `fire_watch_app`).
 *
 * ## The watermark
 *
 * Never stored twice: the newest `send` or `suppress` window over every zone the account
 * has ever had (soft-deleted ones included, so deleting a zone never re-opens a window),
 * and the **earliest** `decided_at` recorded for that window. Two passes that raced on
 * one window can log it at two instants; taking the earlier one means a debt recorded
 * between them is still read as unpaid. That can only change the *kind* a pair is owed
 * as, never whether it is listed — `deferred` and `active` are both owed — so the
 * conservative side is the one that does not claim a debt was paid.
 *
 * ## The pairs
 *
 * `alert_states` rows other than `none` on the account's live sealed zones, whose event is
 * digestible (the port's definition): not a merge tombstone, not a reignition parent that
 * a child supersedes, not invalidated, and `active` or `signal_weakening`. The newest
 * evaluation-pass `defer` per pair comes from migration 014's log, served by its
 * `(watch_zone_id, fire_event_id, decided_at)` index.
 *
 * **Known limit.** The decision log is keyed by the event the decision was taken on. When a
 * merge or a reignition later folds that event's `alert_states` row onto another event
 * (ADR-002 I3), the row moves and its `defer` history does not, so the survivor's pair
 * reads `lastDeferredAtIso: null` and is owed as `active` (or `seeded`) rather than
 * `deferred`. It is still listed — `active` is owed unconditionally — so no fire is lost
 * from a digest; only the kind label, and whatever copy keys on it, is affected. The replay
 * (`core/replay/alert-engine.ts`) behaves the same way: its debts are keyed by the parent's
 * public id and `migrateParentStates` moves the state rows, not the debts.
 */

import type {
  AlertDigestStore,
  AlertDigestTransaction,
  DigestLogEntry,
  DigestPairRow,
  DigestWatermark,
} from '../../core/ports/alert-digest-store.js';
import { isoFromEpochMs } from '../../core/ports/clock.js';
import type { AccountAlertSettings } from '../../core/ports/watch-zone-store.js';
import { createPgAlertOutboxStore } from './pg-alert-outbox-store.js';
import { createPgWatchZoneStore } from './pg-watch-zone-store.js';
import { boolean, epochMs, field, number, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgAlertDigestQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgAlertDigestClient extends PgAlertDigestQueryable {
  release(): void;
}

export interface PgAlertDigestPool extends PgAlertDigestQueryable {
  connect(): Promise<PgAlertDigestClient>;
}

/** Live accounts with at least one live sealed zone — the ones a digest can be owed to. */
const LIST_ACCOUNTS_AFTER = `
SELECT a.id::text AS id
FROM accounts a
WHERE a.deleted_at IS NULL
  AND ($1::uuid IS NULL OR a.id > $1::uuid)
  AND EXISTS (
    SELECT 1 FROM watch_zones z
    WHERE z.account_id = a.id AND z.deleted_at IS NULL AND z.centre_ciphertext IS NOT NULL
  )
ORDER BY a.id
LIMIT $2::int`.trim();

/** The `pg-watch-zone-store.ts` settings read, holding the row against erasure. */
const LOCK_ACCOUNT = `
SELECT
  timezone,
  to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
  to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
  new_fire_overrides_quiet_hours
FROM accounts
WHERE id = $1::uuid AND deleted_at IS NULL
FOR SHARE`.trim();

/** Soft-deleted zones included: a window one of them consumed stays consumed. */
const SELECT_WATERMARK = `
SELECT l.window_start, min(l.decided_at) AS decided_at
FROM alert_digest_log l
JOIN watch_zones z ON z.id = l.watch_zone_id
WHERE z.account_id = $1::uuid AND l.outcome IN ('send', 'suppress')
GROUP BY l.window_start
ORDER BY l.window_start DESC
LIMIT 1`.trim();

const SELECT_PAIRS = `
SELECT
  s.watch_zone_id::text AS zone_id,
  e.id::text AS fire_event_id,
  e.seq::text AS seq,
  e.public_id,
  ST_Y(e.centroid) AS lat,
  ST_X(e.centroid) AS lon,
  s.seeded_at,
  s.last_notified_at,
  (
    SELECT max(l.decided_at)
    FROM alert_decision_log l
    WHERE l.watch_zone_id = s.watch_zone_id
      AND l.fire_event_id = s.fire_event_id
      AND l.pass = 'evaluation'
      AND l.outcome = 'defer'
  ) AS last_deferred_at
FROM alert_states s
JOIN watch_zones z ON z.id = s.watch_zone_id
JOIN fire_events e ON e.id = s.fire_event_id
WHERE z.account_id = $1::uuid
  AND z.deleted_at IS NULL
  AND z.centre_ciphertext IS NOT NULL
  AND s.state <> 'none'
  AND e.merged_into IS NULL
  AND NOT e.invalidated
  AND e.status IN ('active', 'signal_weakening')
  AND NOT EXISTS (SELECT 1 FROM fire_events c WHERE c.related_event_id = e.id)
ORDER BY z.id, e.public_id`.trim();

/** One statement for the whole decision; a row the unique key already holds is skipped. */
const APPEND_LOG = `
INSERT INTO alert_digest_log (
  watch_zone_id, window_start, outcome, reason, entry_count, rule_version, decided_at
)
SELECT *
FROM unnest(
  $1::uuid[], $2::timestamptz[], $3::text[], $4::text[], $5::int[], $6::text[],
  $7::timestamptz[]
)
ON CONFLICT ON CONSTRAINT alert_digest_log_once_per_window DO NOTHING`.trim();

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ALERT_DIGEST_SQL = Object.freeze({
  listAccountsAfter: LIST_ACCOUNTS_AFTER,
  lockAccount: LOCK_ACCOUNT,
  selectWatermark: SELECT_WATERMARK,
  selectPairs: SELECT_PAIRS,
  appendLog: APPEND_LOG,
});

/** The bound values of {@link APPEND_LOG}, in order. */
export function digestLogArrays(entries: readonly DigestLogEntry[]): readonly unknown[] {
  return [
    entries.map((e) => e.zoneId),
    entries.map((e) => e.windowStartIso),
    entries.map((e) => e.outcome),
    entries.map((e) => e.reason),
    entries.map((e) => e.entryCount),
    entries.map((e) => e.ruleVersion),
    entries.map((e) => e.decidedAtIso),
  ];
}

/** The transaction's reads and writes over one already-`BEGIN`-ed client. */
export function alertDigestTransactionOver(client: PgAlertDigestQueryable): AlertDigestTransaction {
  const zones = createPgWatchZoneStore(client);
  return {
    async lockAccount(accountId): Promise<AccountAlertSettings | null> {
      const result = await client.query(LOCK_ACCOUNT, [accountId]);
      const [row] = result.rows;
      if (row === undefined) return null;
      return {
        timezone: string(field(row, 'timezone'), 'timezone'),
        quietHoursStart: string(field(row, 'quiet_hours_start'), 'quiet_hours_start'),
        quietHoursEnd: string(field(row, 'quiet_hours_end'), 'quiet_hours_end'),
        newFireOverridesQuietHours: boolean(
          field(row, 'new_fire_overrides_quiet_hours'),
          'new_fire_overrides_quiet_hours',
        ),
      };
    },

    listZones: (accountId) => zones.listForAccount(accountId),

    async readWatermark(accountId): Promise<DigestWatermark | null> {
      const result = await client.query(SELECT_WATERMARK, [accountId]);
      const [row] = result.rows;
      if (row === undefined) return null;
      return {
        windowStartIso: isoFromEpochMs(epochMs(field(row, 'window_start'), 'window_start')),
        decidedAtIso: isoFromEpochMs(epochMs(field(row, 'decided_at'), 'decided_at')),
      };
    },

    async loadPairs(accountId): Promise<readonly DigestPairRow[]> {
      const result = await client.query(SELECT_PAIRS, [accountId]);
      return result.rows.map(decodePairRow);
    },

    async appendLog(entries): Promise<number> {
      if (entries.length === 0) return 0;
      const result = await client.query(APPEND_LOG, digestLogArrays(entries));
      return result.rowCount ?? 0;
    },

    outbox: createPgAlertOutboxStore(client),
  };
}

/** Decodes one row of {@link SELECT_PAIRS}. Throws on any unexpected shape. */
export function decodePairRow(row: unknown): DigestPairRow {
  return {
    zoneId: string(field(row, 'zone_id'), 'zone_id'),
    fireEventId: decimalText(field(row, 'fire_event_id'), 'fire_event_id'),
    seq: decimalText(field(row, 'seq'), 'seq'),
    eventPublicId: string(field(row, 'public_id'), 'public_id'),
    centroid: { lat: number(field(row, 'lat'), 'lat'), lon: number(field(row, 'lon'), 'lon') },
    seededAtIso: optionalIso(field(row, 'seeded_at'), 'seeded_at'),
    lastNotifiedAtIso: optionalIso(field(row, 'last_notified_at'), 'last_notified_at'),
    lastDeferredAtIso: optionalIso(field(row, 'last_deferred_at'), 'last_deferred_at'),
  };
}

export function createPgAlertDigestStore(pool: PgAlertDigestPool): AlertDigestStore {
  return {
    async listAccountsAfter(afterId, limit): Promise<readonly string[]> {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError(`limit must be a positive integer, got ${String(limit)}`);
      }
      const result = await pool.query(LIST_ACCOUNTS_AFTER, [afterId, limit]);
      return result.rows.map((row) => string(field(row, 'id'), 'id'));
    },

    async withAccount(_accountId, work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(alertDigestTransactionOver(client));
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

function optionalIso(value: unknown, name: string): string | null {
  return value === null ? null : isoFromEpochMs(epochMs(value, name));
}

function decimalText(value: unknown, name: string): string {
  const text = string(value, name);
  if (!/^\d+$/.test(text)) throw new Error(`${name} is not decimal text`);
  return text;
}
