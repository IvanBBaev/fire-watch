/**
 * Builds the self-serve export of one account: `account_export_v1` (TASKS I6; GDPR Art. 15
 * and 20; 05 §5.3.7).
 *
 * The document is one JSON object — machine-readable for Art. 20, and plain enough to be
 * read by a person for Art. 15. It carries, besides the rows:
 *   - `coverage`: the tables read, which are exactly the erasure plan's;
 *   - `withheld`: every column that exists and is not exported, with the reason;
 *   - `limits`: what this export cannot contain (pseudonymized history, access logs, the
 *     providers' own records, backups).
 *
 * **Zone centres are opened.** The sealed centre (migration 007) is the person's own home
 * or field, and an export that handed back ciphertext would not answer an access request.
 * The builder opens it with the zone cipher and adds it as `centre`, with `centre_status`
 * saying how it was obtained. A centre that does not open is reported as `unreadable`
 * rather than failing the whole export: the rest of the data is still owed, and the
 * status tells the person (and support) exactly which zone is affected.
 *
 * **Allow-list, fail closed.** A row whose columns are not exactly the schema's for its
 * table throws. That is what guarantees a token hash or a sealed centre never reaches a
 * document, whatever the adapter selects.
 *
 * Nothing here reads a clock; `at` is passed in.
 */

import { ERASURE_PLAN_VERSION } from '../erasure/erasure-plan.js';
import type {
  AccountExportSource,
  ExportJson,
  ExportRow,
  ExportRowTable,
  ExportSelector,
} from '../ports/account-export-source.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import type { SealedCentre, ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import {
  ACCOUNT_EXPORT_TABLES,
  EXPORT_COLUMNS,
  EXPORT_LIMITS,
  EXPORT_SCOPES,
  EXPORT_WITHHELD,
  type AccountExportTable,
  type ExportColumnKind,
  type WithheldColumn,
} from './export-schema.js';

export const ACCOUNT_EXPORT_FORMAT = 'account_export_v1';

export type CentreStatus = 'opened' | 'legacy_plaintext_area' | 'unreadable';

export interface AccountExportDocument {
  readonly format: typeof ACCOUNT_EXPORT_FORMAT;
  readonly generated_at: string;
  readonly account_id: string;
  /** The erasure plan whose table set this export covers. */
  readonly erasure_plan_version: string;
  readonly coverage: readonly AccountExportTable[];
  readonly tables: Readonly<Record<AccountExportTable, readonly ExportRow[]>>;
  readonly withheld: readonly WithheldColumn[];
  readonly limits: readonly string[];
}

export type AccountExportOutcome =
  | { readonly status: 'exported'; readonly document: AccountExportDocument }
  /** An erased account has nothing left to export but its ledger row, which names no one. */
  | { readonly status: 'erased' }
  | { readonly status: 'missing' };

/** The tables `readRows` serves, in document order. */
const ROW_TABLES = ACCOUNT_EXPORT_TABLES.filter(
  (table): table is ExportRowTable => table !== 'accounts' && table !== 'watch_zones',
);

export async function buildAccountExport(
  accountId: string,
  at: EpochMs,
  source: AccountExportSource,
  cipher: ZoneCentreCipher,
): Promise<AccountExportOutcome> {
  const account = await source.readAccount(accountId);
  if (account.state !== 'live') return { status: account.state };
  checkRow('accounts', account.row);

  const zones = await source.readZones(accountId);
  const zoneIds: string[] = [];
  const zoneRows: ExportRow[] = [];
  for (const zone of zones) {
    checkRow('watch_zones', zone.row);
    const id = zone.row['id'];
    if (typeof id !== 'string') throw new Error('watch_zones.id is not a string');
    zoneIds.push(id);
    zoneRows.push({ ...zone.row, ...openCentre(id, zone.sealed, cipher) });
  }

  const tables: Partial<Record<AccountExportTable, readonly ExportRow[]>> = {
    accounts: [account.row],
    watch_zones: zoneRows,
  };
  for (const table of ROW_TABLES) {
    const selector = selectorFor(table, accountId, zoneIds, account.email);
    const rows = selector === null ? [] : await source.readRows(table, selector);
    for (const row of rows) checkRow(table, row);
    tables[table] = rows;
  }

  return {
    status: 'exported',
    document: {
      format: ACCOUNT_EXPORT_FORMAT,
      generated_at: isoFromEpochMs(at),
      account_id: accountId,
      erasure_plan_version: ERASURE_PLAN_VERSION,
      coverage: [...ACCOUNT_EXPORT_TABLES],
      tables: completeTables(tables),
      withheld: EXPORT_WITHHELD,
      limits: EXPORT_LIMITS,
    },
  };
}

/** `null` when there is nothing to select by: no zones, or no address on the account. */
function selectorFor(
  table: ExportRowTable,
  accountId: string,
  zoneIds: readonly string[],
  email: string | null,
): ExportSelector | null {
  switch (EXPORT_SCOPES[table]) {
    case 'account':
      return { by: 'account', accountId };
    case 'account_hash':
      return { by: 'account_hash', accountId };
    case 'zones':
      return zoneIds.length === 0 ? null : { by: 'zones', zoneIds };
    case 'email':
      return email === null ? null : { by: 'email', email };
  }
}

function openCentre(
  zoneId: string,
  sealed: SealedCentre | null,
  cipher: ZoneCentreCipher,
): { readonly centre: ExportJson; readonly centre_status: CentreStatus } {
  if (sealed === null) return { centre: null, centre_status: 'legacy_plaintext_area' };
  try {
    const { lat, lon } = cipher.open(zoneId, sealed);
    return { centre: { lat, lon }, centre_status: 'opened' };
  } catch {
    // The cipher's error names neither key nor plaintext; nothing of it is kept.
    return { centre: null, centre_status: 'unreadable' };
  }
}

function completeTables(
  tables: Partial<Record<AccountExportTable, readonly ExportRow[]>>,
): Record<AccountExportTable, readonly ExportRow[]> {
  const complete = {} as Record<AccountExportTable, readonly ExportRow[]>;
  for (const table of ACCOUNT_EXPORT_TABLES) {
    const rows = tables[table];
    if (rows === undefined) throw new Error(`export read no rows for ${table}`);
    complete[table] = rows;
  }
  return complete;
}

/**
 * The row carries exactly the schema's columns, each of the declared kind. The message
 * names the table and column, never the value — it may end up in a process log.
 */
export function checkRow(table: AccountExportTable, row: ExportRow): void {
  const columns = EXPORT_COLUMNS[table];
  const expected = Object.keys(columns);
  const actual = Object.keys(row);
  for (const column of actual) {
    if (!(column in columns)) {
      throw new Error(`export row for ${table} carries a column outside the schema: ${column}`);
    }
  }
  for (const column of expected) {
    if (!(column in row)) throw new Error(`export row for ${table} lacks ${column}`);
    const kind = columns[column];
    if (kind !== undefined && !matchesKind(row[column] ?? null, kind)) {
      throw new Error(`export row for ${table}.${column} is not a ${kind}`);
    }
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DECIMAL = /^-?\d+$/;

function matchesKind(value: ExportJson, kind: ExportColumnKind): boolean {
  if (value === null) return true;
  switch (kind) {
    case 'id':
    case 'text':
      return typeof value === 'string';
    case 'bigint':
      return typeof value === 'string' && DECIMAL.test(value);
    case 'timestamp':
      return typeof value === 'string' && ISO_UTC.test(value);
    case 'time':
      return typeof value === 'string' && HH_MM.test(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'real':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return true;
    case 'geojson':
      return typeof value === 'object' && !Array.isArray(value);
  }
}
