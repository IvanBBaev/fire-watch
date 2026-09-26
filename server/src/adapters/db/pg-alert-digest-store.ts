/**
 * The digest pass's persistence over Postgres (TASKS H3; ADR-004 D1, D3, A1.7, A1.8, A1.11,
 * A1.12; migration 018). Implements `AlertDigestStore` for `core/alerts/digest-pass.ts`.
 *
 * ## One transaction per account
 *
 * {@link createPgAlertDigestStore}'s `withAccount` takes one client from the pool, `BEGIN`s,
 * and builds every read and write the core does — the account lock, the zones, the
 * watermark, the pairs, the log and the outbox — over *that* client, so the log rows that
 * are the watermark and the outbox rows that deliver the digest commit together or not at
 * all (D1). `COMMIT` or `ROLLBACK`; `ROLLBACK`'s own failure is swallowed so the original
 * error is the one that surfaces.
 *
 * Unlike the evaluation store it takes no fence on `clustering_runs`: the only
 * `fire_events` read is {@link LOAD_PAIRS}, one statement, which under READ COMMITTED
 * already sees one consistent snapshot — and a digest has no cursor that a half-seen batch
 * of identity writes could skip past. Fencing would make every account's digest wait on
 * clustering for nothing.
 *
 * ## Erasure
 *
 * `lockAccount` is the settings select `FOR SHARE`. Erasure takes the account row
 * `FOR UPDATE` first (`pg-account-erasure.ts`), so the two serialize: an erasure already
 * running makes the lock wait, and under READ COMMITTED the re-checked `deleted_at IS NULL`
 * then finds the tombstone and returns no row — the pass writes nothing. A pass that locked
 * first commits first, and its log rows go with the zones through the cascade.
 *
 * ## Never re-delivered
 *
 * `appendLog` is `ON CONFLICT ON CONSTRAINT alert_digest_log_once_per_window DO NOTHING`
 * and resolves the number of rows *inserted*. Two passes racing on one account both hold
 * `FOR SHARE` (compatible) and both read the old watermark; the second one's INSERT waits
 * on the unique index until the first commits and then inserts nothing, and the core
 * writes no outbox row when fewer rows went in than it asked for.
 *
 * ## The watermark
 *
 * The newest window with a `send` or `suppress` row over every zone the account has ever
 * had — soft-deleted zones included, so deleting a zone never re-opens a window another
 * zone already consumed (migration 018). One pass writes the same `decided_at` on every
 * zone's row. Should one window ever carry two instants, the **earliest** is reported: it
 * is the line between a debt the digest paid and one it still owes, and reading it early
 * can at worst list a fire twice, never drop one.
 */

import { isoFromEpochMs } from '../../core/ports/clock.js';
import type {
  AlertDigestStore,
  AlertDigestTransaction,
  DigestLogEntry,
  DigestPairRow,
  DigestWatermark,
} from '../../core/ports/alert-digest-store.js';
import { createPgAlertOutboxStore } from './pg-alert-outbox-store.js';
import { epochMs, field, number, string } from './pg-rows.js';
import {
  SELECT_ACCOUNT_SETTINGS,
  createPgWatchZoneStore,
  decodeAccountAlertSettings,
} from './pg-watch-zone-store.js';

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

/** Live accounts with at least one live sealed zone — the zones `listZones` returns. */
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

const LOCK_ACCOUNT = `${SELECT_ACCOUNT_SETTINGS.trim()}
FOR SHARE`;

const READ_WATERMARK = `
SELECT l.window_start, min(l.decided_at) AS decided_at
FROM alert_digest_log l
JOIN watch_zones z ON z.id = l.watch_zone_id
WHERE z.account_id = $1::uuid AND l.outcome IN ('send', 'suppress')
GROUP BY l.window_start
ORDER BY l.window_start DESC
LIMIT 1`.trim();

/**
 * Every (zone, event) pair the account's live sealed zones have been told about, on an
 * event that is still digestible: not merged away, not superseded by a reignition child
 * (the same test as `ALERTABLE_EVENT_COLUMNS`' `superseded`), not invalidated, and
 * `active` or `signal_weakening` — the digest never says a fire is out, so a fire it
 * stopped seeing simply stops being listed (07 §5.5.3). The newest evaluation `defer` is
 * read through `alert_decision_log_by_pair`.
 */
const LOAD_PAIRS = `
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
    SELECT max(d.decided_at)
    FROM alert_decision_log d
    WHERE d.watch_zone_id = s.watch_zone_id
      AND d.fire_event_id = s.fire_event_id
      AND d.pass = 'evaluation'
      AND d.outcome = 'defer'
  ) AS last_deferred_at
FROM alert_states s
JOIN watch_zones z ON z.id = s.watch_zone_id
JOIN fire_events e ON e.id = s.fire_event_id
WHERE z.account_id = $1::uuid
  AND z.deleted_at IS NULL
  AND z.centre_ciphertext IS NOT NULL
  AND s.state <> 'none'
  AND e.merged_into IS NULL
  AND NOT EXISTS (SELECT 1 FROM fire_events c WHERE c.related_event_id = e.id)
  AND NOT e.invalidated
  AND e.status IN ('active', 'signal_weakening')
ORDER BY s.watch_zone_id, e.id`.trim();

const APPEND_LOG = `
INSERT INTO alert_digest_log
  (watch_zone_id, window_start, outcome, reason, entry_count, rule_version, decided_at)
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
  readWatermark: READ_WATERMARK,
  loadPairs: LOAD_PAIRS,
  appendLog: APPEND_LOG,
});

/** The transaction's reads and writes over one already-`BEGIN`-ed client. */
export function alertDigestTransactionOver(client: PgAlertDigestQueryable): AlertDigestTransaction {
  const zones = createPgWatchZoneStore(client);
  return {
    async lockAccount(accountId) {
      const result = await client.query(LOCK_ACCOUNT, [accountId]);
      const [row] = result.rows;
      return row === undefined ? null : decodeAccountAlertSettings(row);
    },

    listZones: (accountId) => zones.listForAccount(accountId),

    async readWatermark(accountId): Promise<DigestWatermark | null> {
      const result = await client.query(READ_WATERMARK, [accountId]);
      const [row] = result.rows;
      return row === undefined ? null : decodeWatermark(row);
    },

    async loadPairs(accountId): Promise<readonly DigestPairRow[]> {
      const result = await client.query(LOAD_PAIRS, [accountId]);
      return result.rows.map(decodePair);
    },

    async appendLog(entries): Promise<number> {
      if (entries.length === 0) return 0;
      const result = await client.query(APPEND_LOG, appendLogArrays(entries));
      return result.rowCount ?? 0;
    },

    outbox: createPgAlertOutboxStore(client),
  };
}

/** The bound values of {@link APPEND_LOG}, in order. */
export function appendLogArrays(entries: readonly DigestLogEntry[]): readonly unknown[] {
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

export function decodeWatermark(row: unknown): DigestWatermark {
  return {
    windowStartIso: isoFromEpochMs(epochMs(field(row, 'window_start'), 'window_start')),
    decidedAtIso: isoFromEpochMs(epochMs(field(row, 'decided_at'), 'decided_at')),
  };
}

export function decodePair(row: unknown): DigestPairRow {
  return {
    zoneId: string(field(row, 'zone_id'), 'zone_id'),
    fireEventId: string(field(row, 'fire_event_id'), 'fire_event_id'),
    seq: string(field(row, 'seq'), 'seq'),
    eventPublicId: string(field(row, 'public_id'), 'public_id'),
    centroid: { lat: number(field(row, 'lat'), 'lat'), lon: number(field(row, 'lon'), 'lon') },
    seededAtIso: optionalIso(field(row, 'seeded_at'), 'seeded_at'),
    lastNotifiedAtIso: optionalIso(field(row, 'last_notified_at'), 'last_notified_at'),
    lastDeferredAtIso: optionalIso(field(row, 'last_deferred_at'), 'last_deferred_at'),
  };
}

function optionalIso(value: unknown, name: string): string | null {
  return value === null ? null : isoFromEpochMs(epochMs(value, name));
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
