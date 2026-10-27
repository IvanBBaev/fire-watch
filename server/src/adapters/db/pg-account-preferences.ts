/**
 * {@link AccountPreferencesStore} over Postgres (TASKS V2-C5; migration 034).
 *
 * **The write is one conditional statement.** With nothing stored yet the client names
 * revision 0, and the row is created by an `INSERT ... ON CONFLICT DO NOTHING` — a
 * concurrent first write from another device makes this one insert nothing, and nothing
 * returned is the conflict. Otherwise the UPDATE moves the row only `WHERE revision = $4`,
 * bumping it, so of two writes based on the same revision exactly one returns a row.
 * Postgres re-checks the WHERE clause after waiting on a concurrent writer's row lock
 * (READ COMMITTED's re-evaluation), which is what makes the loser see the new revision
 * and match nothing rather than overwrite it.
 *
 * Each call is a single statement, so it runs on the pool directly with no `BEGIN`; a
 * write for an erased account is refused by 010's trigger, though a live session for one
 * cannot exist. The store never reads a clock.
 */

import type {
  AccountPreferencesStore,
  StoredAccountPreferences,
} from '../../core/ports/account-preferences-store.js';
import { field, seqFrom } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgAccountPreferencesQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const SELECT_PREFERENCES = `
SELECT revision::text AS revision, document
FROM account_preferences
WHERE account_id = $1::uuid`;

const INSERT_FIRST = `
INSERT INTO account_preferences (account_id, document, revision, updated_at)
VALUES ($1::uuid, $2::jsonb, 1, $3::timestamptz)
ON CONFLICT (account_id) DO NOTHING
RETURNING revision::text AS revision`;

const UPDATE_IF_REVISION = `
UPDATE account_preferences
SET document = $2::jsonb, revision = revision + 1, updated_at = $3::timestamptz
WHERE account_id = $1::uuid AND revision = $4::bigint
RETURNING revision::text AS revision`;

export const ACCOUNT_PREFERENCES_SQL = {
  select: SELECT_PREFERENCES,
  insertFirst: INSERT_FIRST,
  updateIfRevision: UPDATE_IF_REVISION,
} as const;

export function createPgAccountPreferencesStore(
  db: PgAccountPreferencesQueryable,
): AccountPreferencesStore {
  return {
    async read(accountId): Promise<StoredAccountPreferences | null> {
      const result = await db.query(SELECT_PREFERENCES, [accountId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        revision: seqFrom(field(row, 'revision'), 'revision'),
        document: field(row, 'document'),
      };
    },

    async write(accountId, document, expectedRevision, atIso): Promise<number | null> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('expectedRevision is not a non-negative integer');
      }
      const json = JSON.stringify(document);
      const result =
        expectedRevision === 0
          ? await db.query(INSERT_FIRST, [accountId, json, atIso])
          : await db.query(UPDATE_IF_REVISION, [accountId, json, atIso, String(expectedRevision)]);
      const row = result.rows[0];
      return row === undefined ? null : seqFrom(field(row, 'revision'), 'revision');
    },
  };
}
