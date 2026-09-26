/**
 * Where a self-serve account export reads from (TASKS I6; GDPR Art. 15 and 20).
 *
 * The adapter returns rows already reduced to JSON values in the shape
 * `core/account-export/export-schema.ts` declares for each column, so the core never sees a
 * driver type (`Date`, `Buffer`, a bigint string it has to guess about). It reads inside
 * one read-only snapshot, so a document never mixes two moments.
 *
 * Every row selector is the erasure plan's own predicate for that table: by account, by
 * the account's zones, by the account's e-mail address, or by the ledger's account hash.
 */

import type { AccountExportTable } from '../account-export/export-schema.js';
import type { SealedCentre } from './zone-centre-cipher.js';

export type ExportJson =
  string | number | boolean | null | readonly ExportJson[] | { readonly [key: string]: ExportJson };

export type ExportRow = Readonly<Record<string, ExportJson>>;

export type ExportAccountLookup =
  | { readonly state: 'missing' }
  | { readonly state: 'erased' }
  | {
      readonly state: 'live';
      /** The `accounts` row, in `EXPORT_COLUMNS.accounts` shape. */
      readonly row: ExportRow;
      /** Selects `auth_link_requests`, which has no account foreign key (migration 007). */
      readonly email: string | null;
    };

export interface ExportZone {
  /** `EXPORT_COLUMNS.watch_zones` shape; soft-deleted zones included. */
  readonly row: ExportRow;
  /** NULL for a legacy row that still carries a plaintext `area` (migration 007). */
  readonly sealed: SealedCentre | null;
}

/** The tables read by a plain row selector: everything but `accounts` and `watch_zones`. */
export type ExportRowTable = Exclude<AccountExportTable, 'accounts' | 'watch_zones'>;

export type ExportSelector =
  | { readonly by: 'account'; readonly accountId: string }
  | { readonly by: 'zones'; readonly zoneIds: readonly string[] }
  | { readonly by: 'email'; readonly email: string }
  | { readonly by: 'account_hash'; readonly accountId: string };

export interface AccountExportSource {
  readAccount(accountId: string): Promise<ExportAccountLookup>;
  readZones(accountId: string): Promise<readonly ExportZone[]>;
  /** Rows in a stable order (the adapter's ORDER BY), so two exports of one state match. */
  readRows(table: ExportRowTable, selector: ExportSelector): Promise<readonly ExportRow[]>;
}
