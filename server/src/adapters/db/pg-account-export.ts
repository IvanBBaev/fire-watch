/**
 * Self-serve account export over Postgres (TASKS I6; GDPR Art. 15 and 20): the source
 * `core/account-export/build-account-export.ts` is written against, and the one-snapshot
 * wrapper the route calls.
 *
 * **Exactly the erasure plan's tables, by the erasure plan's predicates.** One statement
 * per table in `ACCOUNT_EXPORT_SQL`, keyed by table name; the unit test compares those
 * keys with `ERASURE_PLAN`, so a table added to erasure without an export statement (or the
 * reverse) fails the build. The WHERE clauses mirror `pg-account-erasure.ts`: by account,
 * by the account's zones (soft-deleted ones included), by e-mail for link requests, and by
 * `sha256(account id)` for the ledger.
 *
 * **Columns come from the schema, not from `*`.** Each SELECT list is generated from
 * `EXPORT_COLUMNS`, with the cast that puts the value in the shape the core checks
 * (timestamps as UTC ISO text, bigints as text, `time` as `HH:MM`, geography as GeoJSON).
 * A token hash is never selected; the sealed zone centre is selected under a reserved
 * alias, handed to the core as a `SealedCentre` for opening, and never put in a row.
 *
 * **One read-only snapshot.** `REPEATABLE READ READ ONLY`, so an export racing a zone edit
 * or a dispatch shows one moment, and cannot write even by mistake.
 */

import type {
  AccountExportSource,
  ExportAccountLookup,
  ExportJson,
  ExportRow,
  ExportRowTable,
  ExportSelector,
  ExportZone,
} from '../../core/ports/account-export-source.js';
import type { EpochMs } from '../../core/ports/clock.js';
import type { ZoneCentreCipher } from '../../core/ports/zone-centre-cipher.js';
import {
  buildAccountExport,
  type AccountExportOutcome,
} from '../../core/account-export/build-account-export.js';
import {
  ACCOUNT_EXPORT_TABLES,
  EXPORT_COLUMNS,
  EXPORT_SCOPES,
  type AccountExportTable,
  type ExportColumnKind,
  type ExportScopeKind,
} from '../../core/account-export/export-schema.js';
import { field } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgExportQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgExportClient extends PgExportQueryable {
  release(): void;
}

export interface PgExportPool extends PgExportQueryable {
  connect(): Promise<PgExportClient>;
}

const SEALED_CIPHERTEXT = 'sealed_centre_ciphertext';
const SEALED_KEY_ID = 'sealed_centre_key_id';

function selectExpression(column: string, kind: ExportColumnKind): string {
  const ref = `t.${column}`;
  switch (kind) {
    case 'id':
    case 'bigint':
      return `${ref}::text AS ${column}`;
    case 'text':
    case 'integer':
    case 'boolean':
    case 'json':
      return `${ref} AS ${column}`;
    case 'real':
      // Through numeric, so a stored 0.45 exports as 0.45 and not as its float4 widening.
      return `${ref}::numeric::float8 AS ${column}`;
    case 'timestamp':
      return `to_char(${ref} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
    case 'time':
      return `to_char(${ref}, 'HH24:MI') AS ${column}`;
    case 'geojson':
      return `ST_AsGeoJSON(${ref})::jsonb AS ${column}`;
  }
}

/** The erasure plan's predicate for each scope (`pg-account-erasure.ts`). */
function whereClause(table: AccountExportTable, scope: ExportScopeKind): string {
  switch (scope) {
    case 'account':
      return table === 'accounts' ? 't.id = $1::uuid' : 't.account_id = $1::uuid';
    case 'zones':
      return 't.watch_zone_id = ANY($1::uuid[])';
    case 'email':
      return 't.email = $1::text';
    case 'account_hash':
      return "t.account_hash = sha256(convert_to($1::text, 'UTF8'))";
  }
}

const ORDER_BY: Readonly<Record<AccountExportTable, string>> = {
  alert_outbox: 't.id',
  alert_states: 't.watch_zone_id, t.fire_event_id',
  alerts_shadow:
    't.decided_at, t.candidate_version, t.watch_zone_id, t.shadow_event_key, t.alert_type, t.alert_subkey',
  alert_decision_log: 't.decided_at, t.id',
  alert_digest_log: 't.decided_at, t.id',
  watch_zones: 't.created_at, t.id',
  channel_confirmations: 't.issued_at, t.id',
  channel_subscriptions: 't.created_at, t.id',
  account_sessions: 't.created_at, t.id',
  auth_link_requests: 't.requested_at, t.id',
  accounts: 't.id',
  erasure_requests: 't.erased_at',
};

function statementFor(table: AccountExportTable): string {
  const columns = Object.entries(EXPORT_COLUMNS[table]).map(([column, kind]) =>
    selectExpression(column, kind),
  );
  if (table === 'watch_zones') {
    columns.push(`t.centre_ciphertext AS ${SEALED_CIPHERTEXT}`);
    columns.push(`t.centre_key_id AS ${SEALED_KEY_ID}`);
  }
  return [
    `SELECT ${columns.join(',\n       ')}`,
    `FROM ${table} AS t`,
    `WHERE ${whereClause(table, EXPORT_SCOPES[table])}`,
    `ORDER BY ${ORDER_BY[table]}`,
  ].join('\n');
}

/** One SELECT per erasure-plan table. Exported for the drift and shape tests. */
export const ACCOUNT_EXPORT_SQL: Readonly<Record<AccountExportTable, string>> = Object.fromEntries(
  ACCOUNT_EXPORT_TABLES.map((table) => [table, statementFor(table)]),
) as Record<AccountExportTable, string>;

/** The row reduced to exactly the schema's columns; anything else the driver sent is dropped. */
function exportRow(table: AccountExportTable, row: unknown): ExportRow {
  const out: Record<string, ExportJson> = {};
  for (const column of Object.keys(EXPORT_COLUMNS[table])) {
    out[column] = field(row, column) as ExportJson;
  }
  return out;
}

function selectorValue(selector: ExportSelector): unknown {
  switch (selector.by) {
    case 'account':
    case 'account_hash':
      return selector.accountId;
    case 'zones':
      return [...selector.zoneIds];
    case 'email':
      return selector.email;
  }
}

/** Binds the source to one client. The caller owns the transaction. */
export function createPgAccountExportSource(db: PgExportQueryable): AccountExportSource {
  return {
    async readAccount(accountId): Promise<ExportAccountLookup> {
      const result = await db.query(ACCOUNT_EXPORT_SQL.accounts, [accountId]);
      const [raw] = result.rows;
      if (raw === undefined) return { state: 'missing' };
      if (field(raw, 'deleted_at') !== null) return { state: 'erased' };
      const email = field(raw, 'email');
      if (email !== null && typeof email !== 'string') {
        throw new TypeError('accounts.email is neither text nor NULL');
      }
      return { state: 'live', row: exportRow('accounts', raw), email };
    },

    async readZones(accountId): Promise<readonly ExportZone[]> {
      const result = await db.query(ACCOUNT_EXPORT_SQL.watch_zones, [accountId]);
      return result.rows.map((raw) => ({
        row: exportRow('watch_zones', raw),
        sealed: sealedCentre(raw),
      }));
    },

    async readRows(table: ExportRowTable, selector: ExportSelector) {
      if (selector.by !== EXPORT_SCOPES[table]) {
        throw new Error(`${table} is selected by ${EXPORT_SCOPES[table]}, not ${selector.by}`);
      }
      const result = await db.query(ACCOUNT_EXPORT_SQL[table], [selectorValue(selector)]);
      return result.rows.map((raw) => exportRow(table, raw));
    },
  };
}

function sealedCentre(raw: unknown): ExportZone['sealed'] {
  const ciphertext = field(raw, SEALED_CIPHERTEXT);
  const keyId = field(raw, SEALED_KEY_ID);
  if (ciphertext === null && keyId === null) return null;
  if (!(ciphertext instanceof Uint8Array) || typeof keyId !== 'string') {
    throw new TypeError('watch_zones sealed centre is incomplete');
  }
  return { ciphertext, keyId };
}

/** What the route calls: one export, one read-only snapshot. */
export type AccountExporter = (accountId: string, at: EpochMs) => Promise<AccountExportOutcome>;

export function createPgAccountExporter(
  pool: PgExportPool,
  cipher: ZoneCentreCipher,
): AccountExporter {
  return async (accountId, at) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const outcome = await buildAccountExport(
        accountId,
        at,
        createPgAccountExportSource(client),
        cipher,
      );
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
