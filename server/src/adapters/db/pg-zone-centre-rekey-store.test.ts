import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { rotateZoneCentreKeys } from '../../core/zones/rotate-zone-centre-keys.js';
import { createAesGcmZoneCipher, SEALED_CENTRE_BYTES } from '../crypto/aes-gcm-zone-cipher.js';
import {
  createPgZoneCentreRekeyStore,
  pgZoneCentreRekeyBatch,
  ZONE_CENTRE_REKEY_SQL,
  type PgZoneRekeyClient,
  type PgZoneRekeyPool,
} from './pg-zone-centre-rekey-store.js';

interface Query {
  readonly text: string;
  readonly values: readonly unknown[];
}

const OLD = { id: 'k1', key: new Uint8Array(32).fill(1) };
const NEW = { id: 'k2', key: new Uint8Array(32).fill(2) };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const zoneId = (n: number): string => `77777777-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * A pool over an in-memory `watch_zones` that answers this module's three statements the
 * way Postgres would, and records every statement and its values. Transactions are
 * snapshot-and-restore; the lock is a no-op (one client).
 */
function fakePool(table: { id: string; ct: Buffer; keyId: string }[]) {
  const queries: Query[] = [];
  const events: string[] = [];
  let snapshot: typeof table | null = null;

  const query = (text: string, values: readonly unknown[] = []) => {
    queries.push({ text, values });
    if (text === 'BEGIN') snapshot = table.map((row) => ({ ...row }));
    if (text === 'ROLLBACK' && snapshot !== null) table.splice(0, table.length, ...snapshot);
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
      events.push(text);
      return { rows: [], rowCount: null };
    }
    if (text === ZONE_CENTRE_REKEY_SQL.lockNotUnder) {
      events.push('lock');
      const [active, after, limit] = values as [string, string | null, number];
      const rows = table
        .filter((row) => row.keyId !== active && (after === null || row.id > after))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map((row) => ({ id: row.id, centre_ciphertext: row.ct, centre_key_id: row.keyId }));
      return { rows, rowCount: rows.length };
    }
    if (text === ZONE_CENTRE_REKEY_SQL.replace) {
      events.push('replace');
      const [ids, oldKeys, oldCts, newKeys, newCts] = values as string[][];
      let changed = 0;
      ids!.forEach((id, i) => {
        const row = table.find((candidate) => candidate.id === id);
        if (row && row.keyId === oldKeys![i] && row.ct.toString('hex') === oldCts![i]) {
          row.keyId = newKeys![i]!;
          row.ct = Buffer.from(newCts![i]!, 'hex');
          changed += 1;
        }
      });
      return { rows: [], rowCount: changed };
    }
    if (text === ZONE_CENTRE_REKEY_SQL.countByKeyId) {
      const counts = new Map<string, number>();
      for (const row of table) counts.set(row.keyId, (counts.get(row.keyId) ?? 0) + 1);
      const rows = [...counts].map(([k, n]) => ({ centre_key_id: k, rows: n }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected statement: ${text}`);
  };

  const run = <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
    Promise.resolve(query(text, values) as { rows: Row[]; rowCount: number | null });
  const pool: PgZoneRekeyPool = {
    query: run,
    connect(): Promise<PgZoneRekeyClient> {
      events.push('connect');
      return Promise.resolve({
        query: run,
        release: () => events.push('release'),
      });
    },
  };
  return { pool, queries, events };
}

function sealedTable(centres: readonly { lat: number; lon: number }[]) {
  const old = createAesGcmZoneCipher({ active: OLD, retired: [] });
  return centres.map((centre, i) => {
    const sealed = old.seal(zoneId(i), centre);
    return { id: zoneId(i), ct: Buffer.from(sealed.ciphertext), keyId: sealed.keyId };
  });
}

const rotatingCipher = () => createAesGcmZoneCipher({ active: NEW, retired: [OLD] });

describe('pg zone-centre rekey store', () => {
  it('locks only rows not under the active key, after the cursor, in id order', () => {
    const sql = ZONE_CENTRE_REKEY_SQL.lockNotUnder;
    expect(sql).toContain('centre_key_id <> $1::text');
    expect(sql).toContain('($2::uuid IS NULL OR id > $2::uuid)');
    expect(sql).toMatch(/ORDER BY id\s+LIMIT \$3::int\s+FOR UPDATE$/);
    expect(sql).not.toContain('deleted_at');
  });

  it('writes only where the row still holds the key id and bytes it read', () => {
    const sql = ZONE_CENTRE_REKEY_SQL.replace;
    expect(sql).toContain('z.centre_key_id = r.old_key_id');
    expect(sql).toContain("z.centre_ciphertext = decode(r.old_ciphertext, 'hex')");
    expect(sql).not.toMatch(/account_id|grid_cell|area/);
  });

  it('runs a whole rotation, one transaction per batch, and every centre survives', async () => {
    const centres = [0, 1, 2, 3, 4].map((i) => ({ lat: 42.1 + i / 100, lon: 23.3 + i / 100 }));
    const table = sealedTable(centres);
    const { pool, events } = fakePool(table);
    const cipher = rotatingCipher();

    const report = await rotateZoneCentreKeys(
      { store: createPgZoneCentreRekeyStore(pool), cipher, activeKeyId: 'k2' },
      { batchSize: 2, maxBatches: null, dryRun: false },
    );

    expect(report).toMatchObject({
      rotated: 5,
      complete: true,
      before: { k1: 5 },
      after: { k2: 5 },
    });
    expect(events.slice(0, 6)).toEqual([
      'connect',
      'BEGIN',
      'lock',
      'replace',
      'COMMIT',
      'release',
    ]);
    expect(events.filter((e) => e === 'COMMIT')).toHaveLength(3);
    for (const [i, row] of table.entries()) {
      expect(row.ct).toHaveLength(SEALED_CENTRE_BYTES);
      expect(cipher.open(row.id, { ciphertext: row.ct, keyId: row.keyId })).toEqual(centres[i]);
    }
  });

  it('rolls back and releases when the work throws, keeping the original error', async () => {
    const table = sealedTable([{ lat: 42.5, lon: 24.5 }]);
    const before = table.map((row) => ({ ...row }));
    const { pool, events } = fakePool(table);
    const store = createPgZoneCentreRekeyStore(pool);
    const boom = new Error('boom');
    await expect(
      store.inBatch(async (batch) => {
        await batch.replace([
          {
            zoneId: table[0]!.id,
            from: { ciphertext: table[0]!.ct, keyId: 'k1' },
            to: { ciphertext: new Uint8Array(44), keyId: 'k2' },
          },
        ]);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(events).toEqual(['connect', 'BEGIN', 'replace', 'ROLLBACK', 'release']);
    expect(table).toEqual(before);
  });

  it('issues no statement for an empty replacement list', async () => {
    const { pool, queries } = fakePool([]);
    expect(await pgZoneCentreRekeyBatch(pool).replace([])).toBe(0);
    expect(queries).toEqual([]);
  });

  it('refuses a ciphertext column that is not bytes', async () => {
    const pool = {
      query: () =>
        Promise.resolve({
          rows: [{ id: zoneId(0), centre_ciphertext: 'abcd', centre_key_id: 'k1' }],
          rowCount: 1,
        }),
    };
    await expect(
      pgZoneCentreRekeyBatch(pool as never).lockNotUnder('k2', null, 10),
    ).rejects.toThrow('centre_ciphertext is not a byte string');
  });

  it('never binds a coordinate: every value is a uuid, a key id, sealed hex or the limit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            lat: fc.double({ min: 41.2, max: 44.3, noNaN: true }),
            lon: fc.double({ min: 22.3, max: 28.7, noNaN: true }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (centres) => {
          const table = sealedTable(centres);
          const { pool, queries } = fakePool(table);
          await rotateZoneCentreKeys(
            {
              store: createPgZoneCentreRekeyStore(pool),
              cipher: rotatingCipher(),
              activeKeyId: 'k2',
            },
            { batchSize: 2, maxBatches: null, dryRun: false },
          );
          const scalars = queries.flatMap((q) =>
            q.values.flatMap((v): unknown[] => (Array.isArray(v) ? (v as unknown[]) : [v])),
          );
          for (const value of scalars) {
            const ok =
              value === null ||
              value === 2 ||
              value === 'k1' ||
              value === 'k2' ||
              (typeof value === 'string' && UUID_RE.test(value)) ||
              (typeof value === 'string' &&
                new RegExp(`^[0-9a-f]{${SEALED_CENTRE_BYTES * 2}}$`).test(value));
            expect(ok, `unexpected bound value ${JSON.stringify(value)}`).toBe(true);
          }
          const text = JSON.stringify(scalars);
          for (const centre of centres) {
            expect(text).not.toContain(String(centre.lat));
            expect(text).not.toContain(String(centre.lon));
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('counts sealed rows per key id', async () => {
    const table = [
      ...sealedTable([
        { lat: 42, lon: 24 },
        { lat: 43, lon: 25 },
      ]),
    ];
    table[1]!.keyId = 'k0';
    const { pool } = fakePool(table);
    const counts = await createPgZoneCentreRekeyStore(pool).countByKeyId();
    expect(Object.fromEntries(counts)).toEqual({ k0: 1, k1: 1 });
    expect(ZONE_CENTRE_REKEY_SQL.countByKeyId).toContain('WHERE centre_ciphertext IS NOT NULL');
  });
});
