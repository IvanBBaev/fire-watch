/**
 * The erasure drill's two database legs (TASKS I7; ADR-004 D8): seeding a synthetic
 * account with a row in every table the erasure plan names, and re-reading the live
 * database after the production eraser has run. The erasure itself is not here — the
 * drill calls `createPgAccountEraser`, the function `DELETE /api/account` runs.
 *
 * **The seed never invents fire data.** The outbox, `alert_states` and
 * `alert_decision_log` all reference `fire_events`, and `alerts_shadow` references
 * `events_shadow`. The drill borrows the newest existing event (and the newest shadow
 * event) instead of writing one, so a staging database is left with no fake fire in it.
 * When none exists, the leg is reported as unseeded with the reason, and the drill's
 * record shows that table as not exercised rather than as passed. `alert_digest_log`
 * (migration 018) references only the zone, so its leg is seeded whenever a zone exists.
 *
 * **Outbox rows are inserted directly**, in the three states the erasure treats
 * differently: `sent` (pseudonymized, kept), `claimed` and `pending` (cancelled, then
 * pseudonymized). Every address is under `example.invalid`, so nothing seeded here can
 * ever be delivered, whatever state a dispatcher finds it in.
 *
 * The seed is one transaction: a failed seed leaves nothing behind.
 */

import { randomUUID } from 'node:crypto';

import { isoFromEpochMs, type EpochMs } from '../../core/ports/clock.js';
import type {
  DeletedTable,
  ErasureDrillObservation,
  ErasureDrillSeed,
  ObservedOutboxRow,
  SeededOutboxRow,
} from '../../core/drills/erasure-verification.js';
import type { PgErasurePool, PgErasureQueryable } from './pg-account-erasure.js';
import { epochMs, field, number, string } from './pg-rows.js';

export interface SeedDrillAccountOptions {
  readonly nowMs: EpochMs;
  /** Defaults to `drill-<uuid>@example.invalid`. Must stay under `.invalid`. */
  readonly email?: string;
  /** Zones to create; the outbox and decision-log legs need at least four. */
  readonly zoneCount?: number;
}

const DAY_MS = 86_400_000;
const ZONE_COUNT = 4;
const RULE_VERSION = 'alert_gating_v1';
const DIGEST_RULE_VERSION = 'digest_params_v1';
const TEMPLATE_ID = 'new_fire.bg.v3';

/** The outbox rows the seed writes, one zone each: the states erasure treats differently. */
const OUTBOX_STATES = ['sent', 'claimed', 'pending'] as const;

const INSERT_ACCOUNT = `
INSERT INTO accounts (timezone, email, email_verified_at)
VALUES ('Europe/Sofia', $1::text, $2::timestamptz)
RETURNING id::text AS id`;

const INSERT_SUBSCRIPTION = `
INSERT INTO channel_subscriptions (account_id, channel, endpoint)
VALUES ($1::uuid, 'push', 'https://example.invalid/push/erasure-drill')
RETURNING id::text AS id`;

const INSERT_ZONES = `
INSERT INTO watch_zones (account_id, name, area, radius_m)
SELECT $1::uuid, 'Drill zone ' || n, ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000
FROM generate_series(1, $2::integer) AS n
RETURNING id::text AS id`;

const INSERT_SESSION = `
INSERT INTO account_sessions (token_hash, account_id, ua_family, created_at, last_seen_at, expires_at)
VALUES (sha256(convert_to($2::text || ':session', 'UTF8')), $1::uuid, 'firefox',
        $3::timestamptz, $3::timestamptz, $4::timestamptz)`;

const INSERT_LINK_REQUEST = `
INSERT INTO auth_link_requests (email, token_hash, ua_family, requested_at, expires_at)
VALUES ($1::text, sha256(convert_to($1::text || ':link', 'UTF8')), 'firefox',
        $2::timestamptz, $3::timestamptz)`;

const INSERT_CONFIRMATIONS = `
INSERT INTO channel_confirmations
  (account_id, channel, channel_subscription_id, token_hash, issued_at, expires_at)
VALUES ($1::uuid, 'push', $2::uuid, sha256(convert_to($3::text || ':confirm', 'UTF8')),
        $4::timestamptz, $5::timestamptz),
       ($1::uuid, 'telegram', NULL, sha256(convert_to($3::text || ':telegram', 'UTF8')),
        $4::timestamptz, $5::timestamptz)`;

const NEWEST_FIRE_EVENT = `
SELECT id::text AS id, seq::text AS seq FROM fire_events ORDER BY id DESC LIMIT 1`;

const NEWEST_SHADOW_EVENT = `
SELECT candidate_version, shadow_key FROM events_shadow ORDER BY recorded_at DESC LIMIT 1`;

const INSERT_ALERT_STATE = `
INSERT INTO alert_states (watch_zone_id, fire_event_id, state)
VALUES ($1::uuid, $2::bigint, 'notified_new')`;

const INSERT_SHADOW_ALERT = `
INSERT INTO alerts_shadow (
  candidate_version, watch_zone_id, shadow_event_key, alert_type, alert_subkey,
  trigger_type, rule_version, template_id, template_params, decided_at
)
VALUES ($1::text, $2::uuid, $3::text, 'new_fire', 'once', 'new_fire', $4::text, $5::text,
        '{"distanceKm": 4.2}'::jsonb, $6::timestamptz)`;

/** One suppressed evaluation, one zone-creation seed: both outcomes carry no alert type. */
const INSERT_DECISIONS = `
INSERT INTO alert_decision_log (
  watch_zone_id, fire_event_id, trigger_ref_seq, pass, outcome, reason, code,
  alert_type, ladder_step, in_quiet_hours, rule_version, decided_at
)
VALUES ($1::uuid, $3::bigint, $4::bigint, 'evaluation', 'suppress', 'geo_only',
        'suppressed_geo_only', NULL, 0, false, $5::text, $6::timestamptz),
       ($2::uuid, $3::bigint, $4::bigint, 'zone_creation', 'seed', 'pre_existing_event',
        'seeded_pre_existing_event', NULL, 0, false, $5::text, $6::timestamptz)`;

/**
 * One spent window and one held window, the two outcomes that carry no outbox row (a
 * `send` must have lines, and the drill writes no digest). Both on the first zone.
 */
const INSERT_DIGEST_DECISIONS = `
INSERT INTO alert_digest_log (
  watch_zone_id, window_start, outcome, reason, entry_count, rule_version, decided_at
)
VALUES ($1::uuid, $3::timestamptz - interval '1 day', 'suppress', 'nothing_active', 0,
        $2::text, $3::timestamptz - interval '1 day'),
       ($1::uuid, $3::timestamptz, 'hold', 'quiet_hours', 0, $2::text, $3::timestamptz)`;

const INSERT_OUTBOX_ROW = `
INSERT INTO alert_outbox (
  watch_zone_id, fire_event_id, alert_type, alert_subkey, trigger_type, trigger_ref_seq,
  rule_version, template_id, template_params, channel, channel_subscription_id, priority,
  status, decided_at, dispatched_at, provider_ack_at, claimed_at
)
VALUES ($1::uuid, $2::bigint, 'new_fire', 'once', 'new_fire', $3::bigint, $4::text, $5::text,
        '{"distanceKm": 4.2, "zoneName": "Drill zone"}'::jsonb, 'push', $6::uuid, 10,
        $7::text, $8::timestamptz, $9::timestamptz, $9::timestamptz, $10::timestamptz)
RETURNING id::text AS id`;

const REMAINING = `
SELECT
  (SELECT count(*)::integer FROM alert_states WHERE watch_zone_id = ANY($2::uuid[])) AS alert_states,
  (SELECT count(*)::integer FROM alerts_shadow WHERE watch_zone_id = ANY($2::uuid[])) AS alerts_shadow,
  (SELECT count(*)::integer FROM alert_decision_log WHERE watch_zone_id = ANY($2::uuid[])) AS alert_decision_log,
  (SELECT count(*)::integer FROM alert_digest_log WHERE watch_zone_id = ANY($2::uuid[])) AS alert_digest_log,
  (SELECT count(*)::integer FROM watch_zones
     WHERE account_id = $1::uuid OR id = ANY($2::uuid[])) AS watch_zones,
  (SELECT count(*)::integer FROM channel_confirmations WHERE account_id = $1::uuid) AS channel_confirmations,
  (SELECT count(*)::integer FROM channel_subscriptions WHERE account_id = $1::uuid) AS channel_subscriptions,
  (SELECT count(*)::integer FROM account_sessions WHERE account_id = $1::uuid) AS account_sessions,
  (SELECT count(*)::integer FROM auth_link_requests WHERE email = $3::text) AS auth_link_requests`;

const ACCOUNT_ROW = `
SELECT email IS NULL AS email_null, email_verified_at IS NULL AS email_verified_null, deleted_at
FROM accounts WHERE id = $1::uuid`;

const LEDGER_ROW = `
SELECT erased_at, deadline_at, plan_version, counts
FROM erasure_requests
WHERE account_hash = sha256(convert_to($1::text, 'UTF8'))`;

const OUTBOX_ROWS = `
SELECT id::text AS id, status,
       watch_zone_id IS NULL AS watch_zone_id_null,
       channel_subscription_id IS NULL AS channel_subscription_id_null,
       template_params, pseudonymized_at
FROM alert_outbox WHERE id = ANY($1::bigint[]) ORDER BY id`;

const PERSONAL_TABLES = `
SELECT table_name FROM table_backup_class WHERE class = 'personal' ORDER BY table_name`;

/** A write the tombstone must refuse (migration 010's trigger on the account's children). */
const PROBE_WRITE = `
INSERT INTO channel_subscriptions (account_id, channel, endpoint)
VALUES ($1::uuid, 'push', 'https://example.invalid/push/erasure-drill-probe')`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const ERASURE_DRILL_SQL = {
  insertAccount: INSERT_ACCOUNT,
  insertSubscription: INSERT_SUBSCRIPTION,
  insertZones: INSERT_ZONES,
  insertSession: INSERT_SESSION,
  insertLinkRequest: INSERT_LINK_REQUEST,
  insertConfirmations: INSERT_CONFIRMATIONS,
  newestFireEvent: NEWEST_FIRE_EVENT,
  newestShadowEvent: NEWEST_SHADOW_EVENT,
  insertAlertState: INSERT_ALERT_STATE,
  insertShadowAlert: INSERT_SHADOW_ALERT,
  insertDecisions: INSERT_DECISIONS,
  insertDigestDecisions: INSERT_DIGEST_DECISIONS,
  insertOutboxRow: INSERT_OUTBOX_ROW,
  remaining: REMAINING,
  accountRow: ACCOUNT_ROW,
  ledgerRow: LEDGER_ROW,
  outboxRows: OUTBOX_ROWS,
  personalTables: PERSONAL_TABLES,
  probeWrite: PROBE_WRITE,
} as const;

const DELETED_TABLES: readonly DeletedTable[] = [
  'alert_states',
  'alerts_shadow',
  'alert_decision_log',
  'alert_digest_log',
  'watch_zones',
  'channel_confirmations',
  'channel_subscriptions',
  'account_sessions',
  'auth_link_requests',
];

export function drillEmail(): string {
  return `drill-${randomUUID()}@example.invalid`;
}

export async function seedDrillAccount(
  pool: PgErasurePool,
  options: SeedDrillAccountOptions,
): Promise<ErasureDrillSeed> {
  const email = options.email ?? drillEmail();
  if (!email.endsWith('@example.invalid')) {
    throw new Error(`drill address ${email} is not under example.invalid`);
  }
  const zoneCount = options.zoneCount ?? ZONE_COUNT;
  const now = isoFromEpochMs(options.nowMs);
  const inADay = isoFromEpochMs(options.nowMs + DAY_MS);

  return inTransaction(pool, async (db) => {
    const accountId = firstString(await db.query(INSERT_ACCOUNT, [email, now]), 'id');
    const subscriptionId = firstString(await db.query(INSERT_SUBSCRIPTION, [accountId]), 'id');
    const zones = await db.query(INSERT_ZONES, [accountId, zoneCount]);
    const zoneIds = zones.rows.map((row) => string(field(row, 'id'), 'zone id'));
    await db.query(INSERT_SESSION, [accountId, email, now, inADay]);
    await db.query(INSERT_LINK_REQUEST, [email, now, inADay]);
    await db.query(INSERT_CONFIRMATIONS, [accountId, subscriptionId, email, now, inADay]);

    const rows: Record<DeletedTable, number> = {
      alert_states: 0,
      alerts_shadow: 0,
      alert_decision_log: 0,
      alert_digest_log: 0,
      watch_zones: zoneIds.length,
      channel_confirmations: 2,
      channel_subscriptions: 1,
      account_sessions: 1,
      auth_link_requests: 1,
    };
    const unseeded: Partial<Record<DeletedTable | 'alert_outbox', string>> = {};
    const outbox: SeededOutboxRow[] = [];

    const [zoneA, zoneB, zoneC, zoneD] = zoneIds;
    if (zoneA === undefined) {
      unseeded.alert_digest_log = 'the seed made no zone to key a digest decision by';
    } else {
      await db.query(INSERT_DIGEST_DECISIONS, [zoneA, DIGEST_RULE_VERSION, now]);
      rows.alert_digest_log = 2;
    }
    if (zoneA === undefined || zoneB === undefined || zoneC === undefined || zoneD === undefined) {
      const reason = `the seed made ${String(zoneIds.length)} zones; the fire-keyed legs need ${String(ZONE_COUNT)}`;
      unseeded.alert_states = reason;
      unseeded.alert_decision_log = reason;
      unseeded.alert_outbox = reason;
      unseeded.alerts_shadow = reason;
      return { accountId, email, zoneIds, rows, outbox, unseeded };
    }

    const event = (await db.query(NEWEST_FIRE_EVENT)).rows[0];
    if (event === undefined) {
      const reason = 'no fire_events row to reference (the drill never invents one)';
      unseeded.alert_states = reason;
      unseeded.alert_decision_log = reason;
      unseeded.alert_outbox = reason;
    } else {
      const eventId = string(field(event, 'id'), 'fire event id');
      const eventSeq = string(field(event, 'seq'), 'fire event seq');
      await db.query(INSERT_ALERT_STATE, [zoneA, eventId]);
      rows.alert_states = 1;
      await db.query(INSERT_DECISIONS, [zoneD, zoneA, eventId, eventSeq, RULE_VERSION, now]);
      rows.alert_decision_log = 2;
      const zonesByState = [zoneA, zoneB, zoneC];
      for (const [index, status] of OUTBOX_STATES.entries()) {
        const id = firstString(
          await db.query(INSERT_OUTBOX_ROW, [
            zonesByState[index],
            eventId,
            eventSeq,
            RULE_VERSION,
            TEMPLATE_ID,
            subscriptionId,
            status,
            now,
            status === 'sent' ? now : null,
            // Migration 015: a `claimed` row must carry its lease; a sent row keeps the
            // instant of its last claim. Only a pending row has never been claimed.
            status === 'pending' ? null : now,
          ]),
          'id',
        );
        outbox.push({ id, seededStatus: status });
      }
    }

    const shadow = (await db.query(NEWEST_SHADOW_EVENT)).rows[0];
    if (shadow === undefined) {
      unseeded.alerts_shadow = 'no events_shadow row to reference (the drill never invents one)';
    } else {
      await db.query(INSERT_SHADOW_ALERT, [
        string(field(shadow, 'candidate_version'), 'candidate_version'),
        zoneB,
        string(field(shadow, 'shadow_key'), 'shadow_key'),
        RULE_VERSION,
        TEMPLATE_ID,
        now,
      ]);
      rows.alerts_shadow = 1;
    }

    return { accountId, email, zoneIds, rows, outbox, unseeded };
  });
}

export async function observeErasure(
  pool: PgErasurePool,
  seed: ErasureDrillSeed,
): Promise<ErasureDrillObservation> {
  const counts = (await pool.query(REMAINING, [seed.accountId, [...seed.zoneIds], seed.email]))
    .rows[0];
  if (counts === undefined) throw new Error('the remaining-rows query returned no row');
  const remaining = Object.fromEntries(
    DELETED_TABLES.map((table) => [table, number(field(counts, table), table)]),
  ) as Record<DeletedTable, number>;

  const accountRow = (await pool.query(ACCOUNT_ROW, [seed.accountId])).rows[0];
  const account =
    accountRow === undefined
      ? { exists: false, emailNull: true, emailVerifiedNull: true, deletedAtMs: null }
      : {
          exists: true,
          emailNull: field(accountRow, 'email_null') === true,
          emailVerifiedNull: field(accountRow, 'email_verified_null') === true,
          deletedAtMs: nullableEpochMs(field(accountRow, 'deleted_at'), 'deleted_at'),
        };

  const ledgerRow = (await pool.query(LEDGER_ROW, [seed.accountId])).rows[0];
  const ledger =
    ledgerRow === undefined
      ? null
      : {
          erasedAtMs: epochMs(field(ledgerRow, 'erased_at'), 'erased_at'),
          deadlineAtMs: epochMs(field(ledgerRow, 'deadline_at'), 'deadline_at'),
          planVersion: string(field(ledgerRow, 'plan_version'), 'plan_version'),
          counts: objectOf(field(ledgerRow, 'counts')),
        };

  const outboxRows = await pool.query(OUTBOX_ROWS, [seed.outbox.map((row) => row.id)]);
  const outbox: ObservedOutboxRow[] = outboxRows.rows.map((row) => ({
    id: string(field(row, 'id'), 'outbox id'),
    status: string(field(row, 'status'), 'outbox status'),
    watchZoneIdNull: field(row, 'watch_zone_id_null') === true,
    channelSubscriptionIdNull: field(row, 'channel_subscription_id_null') === true,
    templateParamKeys: Object.keys(objectOf(field(row, 'template_params'))).sort(),
    pseudonymizedAtMs: nullableEpochMs(field(row, 'pseudonymized_at'), 'pseudonymized_at'),
  }));

  const personal = await pool.query(PERSONAL_TABLES);
  const personalTables = personal.rows.map((row) => string(field(row, 'table_name'), 'table_name'));

  return {
    remaining,
    account,
    ledger,
    outbox,
    erasedWriteRefused: await probeWrite(pool, seed.accountId),
    personalTables,
  };
}

/** SQLSTATE `foreign_key_violation`: what migration 010's tombstone guard raises. */
const TOMBSTONE_REFUSAL_SQLSTATE = '23503';

/**
 * Tries a write the erased account must refuse, inside a transaction that is always
 * rolled back. `true` when refused **by the tombstone guard** (SQLSTATE 23503), `false`
 * when accepted (and undone), `null` when the probe could not start or failed for any
 * other reason — a missing grant or a broken statement proves nothing about the guard.
 */
async function probeWrite(pool: PgErasurePool, accountId: string): Promise<boolean | null> {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
  } catch {
    client?.release();
    return null;
  }
  try {
    await client.query(PROBE_WRITE, [accountId]);
    return false;
  } catch (error) {
    return (error as { code?: unknown }).code === TOMBSTONE_REFUSAL_SQLSTATE ? true : null;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function inTransaction<T>(
  pool: PgErasurePool,
  work: (client: PgErasureQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function firstString(result: { rows: Record<string, unknown>[] }, column: string): string {
  const [row] = result.rows;
  if (row === undefined) throw new Error(`insert returned no ${column}`);
  return string(field(row, column), column);
}

function nullableEpochMs(value: unknown, name: string): EpochMs | null {
  return value === null ? null : epochMs(value, name);
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
