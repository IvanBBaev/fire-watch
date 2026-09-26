/**
 * The zone-centre key rotation's store over Postgres (TASKS I2; migration 007's
 * `centre_ciphertext` / `centre_key_id`; the port is `core/ports/zone-centre-rekey-store.ts`).
 *
 * No migration: 007 added both columns and `fire_watch_app` has held UPDATE on
 * `watch_zones` since 001. The only columns written are those two — never `account_id`,
 * so migration 010's erased-account trigger does not fire, and never `grid_cell`, which a
 * rotation does not move.
 *
 * ## One transaction per batch
 *
 * {@link createPgZoneCentreRekeyStore}'s `inBatch` checks a client out of the pool, opens
 * `BEGIN`, and commits when the work resolves; a throw rolls back, and ROLLBACK's own
 * failure never masks the original (the `pg-auth.ts` shape).
 *
 * ## What reaches SQL
 *
 * Ciphertext bytes, key ids, zone ids (uuids) and a limit — nothing else exists at this
 * layer. The centre is opened and re-sealed in the core; it never reaches a parameter.
 * The ciphertext travels as hex text and is decoded in SQL, the same bytes either way,
 * so the batched `unnest` needs no driver-specific `bytea[]` encoding.
 *
 * ## Compare-and-swap
 *
 * The UPDATE matches the id *and* the key id *and* the exact ciphertext the batch read.
 * The rows are locked `FOR UPDATE` for the batch as well, so the CAS only matters if a
 * writer outside that lock (a hand-run statement, a future code path) touched a row; it
 * then changes nothing, and the core counts the shortfall as raced.
 *
 * Soft-deleted rows are rotated too: a retired key cannot be dropped while any row, live
 * or not, still names it.
 */

import type { SealedCentre } from '../../core/ports/zone-centre-cipher.js';
import type {
  SealedZoneCentre,
  ZoneCentreRekeyBatch,
  ZoneCentreRekeyStore,
  ZoneCentreReplacement,
} from '../../core/ports/zone-centre-rekey-store.js';
import { field, number, string } from './pg-rows.js';

/** The slice of `pg` this module uses. */
export interface PgZoneRekeyQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgZoneRekeyClient extends PgZoneRekeyQueryable {
  release(): void;
}

export interface PgZoneRekeyPool extends PgZoneRekeyQueryable {
  connect(): Promise<PgZoneRekeyClient>;
}

const LOCK_NOT_UNDER = `
SELECT id::text AS id, centre_ciphertext, centre_key_id
FROM watch_zones
WHERE centre_ciphertext IS NOT NULL
  AND centre_key_id <> $1::text
  AND ($2::uuid IS NULL OR id > $2::uuid)
ORDER BY id
LIMIT $3::int
FOR UPDATE
`.trim();

const REPLACE = `
UPDATE watch_zones AS z
SET centre_ciphertext = decode(r.new_ciphertext, 'hex'),
    centre_key_id     = r.new_key_id
FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
  AS r(id, old_key_id, old_ciphertext, new_key_id, new_ciphertext)
WHERE z.id = r.id
  AND z.centre_key_id = r.old_key_id
  AND z.centre_ciphertext = decode(r.old_ciphertext, 'hex')
`.trim();

const COUNT_BY_KEY_ID = `
SELECT centre_key_id, count(*)::int AS rows
FROM watch_zones
WHERE centre_ciphertext IS NOT NULL
GROUP BY centre_key_id
ORDER BY centre_key_id COLLATE "C"
`.trim();

/** Exported for the unit test, which asserts on statement text. */
export const ZONE_CENTRE_REKEY_SQL = {
  lockNotUnder: LOCK_NOT_UNDER,
  replace: REPLACE,
  countByKeyId: COUNT_BY_KEY_ID,
} as const;

export function createPgZoneCentreRekeyStore(pool: PgZoneRekeyPool): ZoneCentreRekeyStore {
  return {
    async inBatch(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(pgZoneCentreRekeyBatch(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async countByKeyId() {
      const { rows } = await pool.query(COUNT_BY_KEY_ID);
      const counts = new Map<string, number>();
      for (const row of rows) {
        counts.set(
          string(field(row, 'centre_key_id'), 'centre_key_id'),
          number(field(row, 'rows'), 'rows'),
        );
      }
      return counts;
    },
  };
}

/** The two statements of one batch, on the batch's client. Exported for the unit test. */
export function pgZoneCentreRekeyBatch(db: PgZoneRekeyQueryable): ZoneCentreRekeyBatch {
  return {
    async lockNotUnder(activeKeyId, afterZoneId, limit) {
      const { rows } = await db.query(LOCK_NOT_UNDER, [activeKeyId, afterZoneId, limit]);
      return rows.map(decodeSealedZone);
    },

    async replace(replacements) {
      if (replacements.length === 0) return 0;
      const { rowCount } = await db.query(REPLACE, replaceParameters(replacements));
      return rowCount ?? 0;
    },
  };
}

function replaceParameters(replacements: readonly ZoneCentreReplacement[]): unknown[] {
  return [
    replacements.map((r) => r.zoneId),
    replacements.map((r) => r.from.keyId),
    replacements.map((r) => hex(r.from)),
    replacements.map((r) => r.to.keyId),
    replacements.map((r) => hex(r.to)),
  ];
}

function hex(sealed: SealedCentre): string {
  return Buffer.from(sealed.ciphertext).toString('hex');
}

function decodeSealedZone(row: Record<string, unknown>): SealedZoneCentre {
  const ciphertext = field(row, 'centre_ciphertext');
  if (!(ciphertext instanceof Uint8Array)) {
    throw new Error('centre_ciphertext is not a byte string');
  }
  return {
    zoneId: string(field(row, 'id'), 'id'),
    sealed: {
      ciphertext: new Uint8Array(ciphertext),
      keyId: string(field(row, 'centre_key_id'), 'centre_key_id'),
    },
  };
}
