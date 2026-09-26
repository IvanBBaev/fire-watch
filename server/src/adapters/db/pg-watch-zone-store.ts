/**
 * {@link WatchZoneStore} over Postgres (TASKS I2; migration 007).
 *
 * **What the INSERT writes, and what it never writes.** A zone row is written with its
 * sealed centre (`centre_ciphertext`, `centre_key_id`), the coarsening flag, and the ~5 km
 * index cell (`grid_version`, `grid_cell`). `area` — 001's plaintext geography — is not
 * named in the statement at all, so it stays NULL, and 007's `watch_zones_sealed_shape`
 * CHECK makes a sealed row that also carried one unrepresentable. The unit test asserts the
 * bound values contain no coordinate in any encoding; the constraint asserts it again at
 * the one place a future edit to this file could not route around.
 *
 * **Reads skip legacy rows.** Rows with a plaintext `area` and no ciphertext (the H3–H6
 * integration fixtures, and nothing written in production) are excluded by
 * `centre_ciphertext IS NOT NULL`: a zone this code cannot open is a zone it must not
 * pretend to list.
 *
 * Like every store here it opens no transaction — the caller `BEGIN`s, because A1.8 puts
 * the zone write and its seed in one — and it never reads a clock.
 */

import type {
  AccountAlertSettings,
  NewWatchZone,
  StoredWatchZone,
  WatchZoneStore,
} from '../../core/ports/watch-zone-store.js';
import { isoFromEpochMs } from '../../core/ports/clock.js';
import { boolean, field, number, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgWatchZoneQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** `to_char` so quiet hours arrive as the `HH:MM` the decision reads, not `HH:MM:SS`. */
const SELECT_ACCOUNT_SETTINGS = `
SELECT
  timezone,
  to_char(quiet_hours_start, 'HH24:MI') AS quiet_hours_start,
  to_char(quiet_hours_end, 'HH24:MI') AS quiet_hours_end,
  new_fire_overrides_quiet_hours
FROM accounts
WHERE id = $1::uuid AND deleted_at IS NULL`;

/** `area` is deliberately absent from the column list. See the module comment. */
const INSERT_ZONE = `
INSERT INTO watch_zones (
  id, account_id, name, radius_m, min_score,
  centre_ciphertext, centre_key_id, centre_coarsened, grid_version, grid_cell, created_at
) VALUES (
  $1::uuid, $2::uuid, $3::text, $4::integer, $5::real,
  $6::bytea, $7::text, $8::boolean, $9::text, $10::text, $11::timestamptz
)`;

const ZONE_COLUMNS = `
  id::text AS id,
  account_id::text AS account_id,
  name,
  radius_m,
  min_score,
  centre_ciphertext,
  centre_key_id,
  centre_coarsened,
  grid_version,
  grid_cell,
  created_at`;

const SELECT_FOR_ACCOUNT = `
SELECT ${ZONE_COLUMNS}
FROM watch_zones
WHERE account_id = $1::uuid AND deleted_at IS NULL AND centre_ciphertext IS NOT NULL
ORDER BY created_at, id`;

/** Served by `watch_zones_grid_cell` (007). */
const SELECT_IN_CELLS = `
SELECT ${ZONE_COLUMNS}
FROM watch_zones
WHERE grid_version = $1::text AND grid_cell = ANY($2::text[])
  AND deleted_at IS NULL AND centre_ciphertext IS NOT NULL
ORDER BY id`;

/** Scoped by account so another account's zone id deletes nothing. */
const SOFT_DELETE = `
UPDATE watch_zones
SET deleted_at = $3::timestamptz
WHERE id = $2::uuid AND account_id = $1::uuid AND deleted_at IS NULL`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const WATCH_ZONE_SQL = {
  selectAccountSettings: SELECT_ACCOUNT_SETTINGS,
  insertZone: INSERT_ZONE,
  selectForAccount: SELECT_FOR_ACCOUNT,
  selectInCells: SELECT_IN_CELLS,
  softDelete: SOFT_DELETE,
} as const;

/** The bound values of {@link INSERT_ZONE}, in order. Exported so the test can inspect them. */
export function insertValues(zone: NewWatchZone): readonly unknown[] {
  return [
    zone.id,
    zone.accountId,
    zone.name,
    zone.radiusM,
    zone.minScore,
    Buffer.from(zone.sealed.ciphertext),
    zone.sealed.keyId,
    zone.coarsened,
    zone.gridVersion,
    zone.gridCell,
    zone.createdAtIso,
  ];
}

export function createPgWatchZoneStore(db: PgWatchZoneQueryable): WatchZoneStore {
  return {
    async loadAccountAlertSettings(accountId): Promise<AccountAlertSettings | null> {
      const result = await db.query(SELECT_ACCOUNT_SETTINGS, [accountId]);
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

    async insert(zone): Promise<void> {
      const result = await db.query(INSERT_ZONE, insertValues(zone));
      if (result.rowCount !== 1) {
        throw new Error('watch zone insert did not write exactly one row');
      }
    },

    async listForAccount(accountId): Promise<readonly StoredWatchZone[]> {
      const result = await db.query(SELECT_FOR_ACCOUNT, [accountId]);
      return result.rows.map(decodeZone);
    },

    async listLiveInCells(gridVersion, cells): Promise<readonly StoredWatchZone[]> {
      if (cells.length === 0) return [];
      const result = await db.query(SELECT_IN_CELLS, [gridVersion, [...cells]]);
      return result.rows.map(decodeZone);
    },

    async softDelete(accountId, zoneId, atIso): Promise<boolean> {
      const result = await db.query(SOFT_DELETE, [accountId, zoneId, atIso]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

function decodeZone(row: Record<string, unknown>): StoredWatchZone {
  const ciphertext = field(row, 'centre_ciphertext');
  if (!(ciphertext instanceof Uint8Array)) {
    throw new Error('centre_ciphertext is not a byte string');
  }
  const createdAt = field(row, 'created_at');
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new Error('created_at is not a timestamp');
  }
  return {
    id: string(field(row, 'id'), 'id'),
    accountId: string(field(row, 'account_id'), 'account_id'),
    name: string(field(row, 'name'), 'name'),
    radiusM: number(field(row, 'radius_m'), 'radius_m'),
    minScore: number(field(row, 'min_score'), 'min_score'),
    sealed: {
      ciphertext: new Uint8Array(ciphertext),
      keyId: string(field(row, 'centre_key_id'), 'centre_key_id'),
    },
    coarsened: boolean(field(row, 'centre_coarsened'), 'centre_coarsened'),
    gridVersion: string(field(row, 'grid_version'), 'grid_version'),
    gridCell: string(field(row, 'grid_cell'), 'grid_cell'),
    createdAtIso: isoFromEpochMs(createdAt.getTime()),
  };
}
