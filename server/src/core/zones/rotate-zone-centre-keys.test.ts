import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Coordinate } from '../clustering/geometry.js';
import type { SealedCentre, ZoneCentreCipher } from '../ports/zone-centre-cipher.js';
import type {
  SealedZoneCentre,
  ZoneCentreRekeyBatch,
  ZoneCentreRekeyStore,
  ZoneCentreReplacement,
} from '../ports/zone-centre-rekey-store.js';
import {
  rotateZoneCentreKeys,
  ZoneKeyRotationError,
  type ZoneKeyRotationOptions,
} from './rotate-zone-centre-keys.js';

/**
 * A transparent keyed cipher: the ciphertext is the key id's bytes, the zone id's and the
 * two float64s, so the tests can see exactly which key a row is under while the rotation
 * sees only what the port gives it. The real AES-GCM cipher runs in the app-level test.
 */
function fakeCipher(options: { readonly active: string; readonly known: readonly string[] }) {
  const encode = (zoneId: string, keyId: string, centre: Coordinate): Uint8Array => {
    const head = Buffer.from(`${keyId}|${zoneId}|`);
    const body = Buffer.alloc(16);
    body.writeDoubleBE(centre.lat, 0);
    body.writeDoubleBE(centre.lon, 8);
    return new Uint8Array(Buffer.concat([head, body]));
  };
  const cipher: ZoneCentreCipher = {
    seal(zoneId, centre): SealedCentre {
      return { ciphertext: encode(zoneId, options.active, centre), keyId: options.active };
    },
    open(zoneId, sealed): Coordinate {
      if (!options.known.includes(sealed.keyId)) throw new Error('unknown key');
      const bytes = Buffer.from(sealed.ciphertext);
      const head = Buffer.from(`${sealed.keyId}|${zoneId}|`);
      if (!bytes.subarray(0, head.length).equals(head)) throw new Error('not authentic');
      return { lat: bytes.readDoubleBE(head.length), lon: bytes.readDoubleBE(head.length + 8) };
    },
  };
  return { cipher, encode };
}

interface Row {
  zoneId: string;
  sealed: SealedCentre;
}

/** An in-memory table with real batch semantics: a batch that throws leaves no writes. */
function memoryStore(rows: Row[], hooks: { beforeReplace?: (rows: Row[]) => void } = {}) {
  const calls = { batches: 0, locks: [] as { after: string | null; limit: number }[] };
  const store: ZoneCentreRekeyStore = {
    async inBatch<T>(work: (batch: ZoneCentreRekeyBatch) => Promise<T>): Promise<T> {
      calls.batches += 1;
      const snapshot = rows.map((row) => ({ ...row }));
      const batch: ZoneCentreRekeyBatch = {
        lockNotUnder(activeKeyId, after, limit) {
          calls.locks.push({ after, limit });
          const picked: SealedZoneCentre[] = rows
            .filter((row) => row.sealed.keyId !== activeKeyId)
            .filter((row) => after === null || row.zoneId > after)
            .sort((a, b) => (a.zoneId < b.zoneId ? -1 : 1))
            .slice(0, limit)
            .map((row) => ({ zoneId: row.zoneId, sealed: row.sealed }));
          return Promise.resolve(picked);
        },
        replace(replacements: readonly ZoneCentreReplacement[]) {
          hooks.beforeReplace?.(rows);
          let changed = 0;
          for (const r of replacements) {
            const row = rows.find((candidate) => candidate.zoneId === r.zoneId);
            if (
              row !== undefined &&
              row.sealed.keyId === r.from.keyId &&
              Buffer.from(row.sealed.ciphertext).equals(Buffer.from(r.from.ciphertext))
            ) {
              row.sealed = r.to;
              changed += 1;
            }
          }
          return Promise.resolve(changed);
        },
      };
      try {
        return await work(batch);
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot);
        throw error;
      }
    },
    countByKeyId() {
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.sealed.keyId, (counts.get(row.sealed.keyId) ?? 0) + 1);
      return Promise.resolve(counts);
    },
  };
  return { store, calls };
}

const zoneId = (n: number): string => `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`;

function table(count: number, keyId: string, encode: ReturnType<typeof fakeCipher>['encode']) {
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    const centre = { lat: 42 + i / 100, lon: 23 + i / 100 };
    rows.push({
      zoneId: zoneId(i),
      sealed: { ciphertext: encode(zoneId(i), keyId, centre), keyId },
    });
  }
  return rows;
}

const RUN: ZoneKeyRotationOptions = { batchSize: 3, maxBatches: null, dryRun: false };

describe('zone-centre key rotation', () => {
  it('moves every row onto the active key, batch by batch, keeping each centre', async () => {
    const { cipher, encode } = fakeCipher({ active: 'k2', known: ['k1', 'k2'] });
    const rows = table(7, 'k1', encode);
    const centres = rows.map((row) => cipher.open(row.zoneId, row.sealed));
    const { store, calls } = memoryStore(rows);

    const report = await rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k2' }, RUN);

    expect(report).toMatchObject({
      examined: 7,
      rotated: 7,
      raced: 0,
      failedByKeyId: {},
      before: { k1: 7 },
      after: { k2: 7 },
      complete: true,
      stoppedEarly: false,
    });
    expect(calls.batches).toBe(3);
    expect(rows.every((row) => row.sealed.keyId === 'k2')).toBe(true);
    expect(rows.map((row) => cipher.open(row.zoneId, row.sealed))).toEqual(centres);
  });

  it('is idempotent: a second run reads nothing and writes nothing', async () => {
    const { cipher, encode } = fakeCipher({ active: 'k2', known: ['k1', 'k2'] });
    const rows = table(4, 'k1', encode);
    const { store } = memoryStore(rows);
    await rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k2' }, RUN);
    const after = rows.map((row) => Buffer.from(row.sealed.ciphertext).toString('hex'));

    const second = await rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k2' }, RUN);
    expect(second).toMatchObject({ batches: 1, examined: 0, rotated: 0, complete: true });
    expect(rows.map((row) => Buffer.from(row.sealed.ciphertext).toString('hex'))).toEqual(after);
  });

  it('is resumable: a run stopped by max batches is finished by the next one', async () => {
    const { cipher, encode } = fakeCipher({ active: 'k2', known: ['k1', 'k2'] });
    const rows = table(8, 'k1', encode);
    const { store } = memoryStore(rows);

    const first = await rotateZoneCentreKeys(
      { store, cipher, activeKeyId: 'k2' },
      { ...RUN, maxBatches: 2 },
    );
    expect(first).toMatchObject({ rotated: 6, stoppedEarly: true, complete: false });
    expect(first.after).toEqual({ k1: 2, k2: 6 });

    const second = await rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k2' }, RUN);
    expect(second).toMatchObject({ rotated: 2, complete: true });
  });

  it('rotates rows under several retired keys in one run', async () => {
    const { cipher, encode } = fakeCipher({ active: 'k3', known: ['k1', 'k2', 'k3'] });
    const rows = [...table(2, 'k1', encode), ...table(5, 'k2', encode).slice(2)];
    const { store } = memoryStore(rows);
    const report = await rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k3' }, RUN);
    expect(report.before).toEqual({ k1: 2, k2: 3 });
    expect(report.after).toEqual({ k3: 5 });
  });

  it('counts a row it cannot open under its key id, leaves it, and moves past it', async () => {
    const { cipher, encode } = fakeCipher({ active: 'k2', known: ['k1', 'k2'] });
    const rows = table(5, 'k1', encode);
    const lost = { ...rows[1]!, sealed: { ...rows[1]!.sealed, keyId: 'k0' } };
    rows[1] = lost;
    const tampered = rows[3]!;
    tampered.sealed = {
      ...tampered.sealed,
      ciphertext: encode(zoneId(99), 'k1', { lat: 0, lon: 0 }),
    };
    const { store } = memoryStore(rows);

    const report = await rotateZoneCentreKeys(
      { store, cipher, activeKeyId: 'k2' },
      { ...RUN, batchSize: 2 },
    );
    expect(report.failedByKeyId).toEqual({ k0: 1, k1: 1 });
    expect(report.rotated).toBe(3);
    expect(report.complete).toBe(false);
    expect(rows[1]?.sealed.keyId).toBe('k0');
    expect(rows[3]?.sealed.keyId).toBe('k1');
  });

  it('writes nothing in a dry run, but reports what it would rotate', async () => {
    const { cipher, encode } = fakeCipher({ active: 'k2', known: ['k1', 'k2'] });
    const rows = table(5, 'k1', encode);
    const before = rows.map((row) => ({ ...row }));
    const { store } = memoryStore(rows);
    const report = await rotateZoneCentreKeys(
      { store, cipher, activeKeyId: 'k2' },
      { ...RUN, dryRun: true },
    );
    expect(report).toMatchObject({ dryRun: true, examined: 5, rotated: 5, complete: false });
    expect(rows).toEqual(before);
  });

  it('never overwrites a row that changed between the read and the write', async () => {
    const { cipher, encode } = fakeCipher({ active: 'k2', known: ['k1', 'k2'] });
    const rows = table(3, 'k1', encode);
    const moved = encode(zoneId(1), 'k1', { lat: 44, lon: 25 });
    const { store } = memoryStore(rows, {
      beforeReplace: (live) => {
        live[1]!.sealed = { ciphertext: moved, keyId: 'k1' };
      },
    });
    const report = await rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k2' }, RUN);
    expect(report).toMatchObject({ rotated: 2, raced: 1 });
    expect(rows[1]?.sealed.ciphertext).toBe(moved);
  });

  it('refuses to rotate onto a key other than the declared one, rolling the batch back', async () => {
    // The cipher's active key is k1, but the run was told k2 is active.
    const { cipher, encode } = fakeCipher({ active: 'k1', known: ['k0', 'k1'] });
    const rows = table(2, 'k0', encode);
    const { store } = memoryStore(rows);
    const snapshot = rows.map((row) => ({ ...row }));
    await expect(rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k2' }, RUN)).rejects.toThrow(
      ZoneKeyRotationError,
    );
    expect(rows).toEqual(snapshot);
  });

  it('rejects a bad batch size or batch cap before touching the store', async () => {
    const { cipher } = fakeCipher({ active: 'k2', known: ['k2'] });
    const { store, calls } = memoryStore([]);
    for (const options of [
      { ...RUN, batchSize: 0 },
      { ...RUN, batchSize: 1.5 },
      { ...RUN, maxBatches: 0 },
    ]) {
      await expect(
        rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k2' }, options),
      ).rejects.toThrow(RangeError);
    }
    expect(calls.batches).toBe(0);
  });

  it('reports key ids and counts only: no zone id, no coordinate, no ciphertext', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            lat: fc.double({ min: 41.3, max: 44.1, noNaN: true }),
            lon: fc.double({ min: 22.5, max: 28.5, noNaN: true }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (centres) => {
          const { cipher, encode } = fakeCipher({ active: 'k2', known: ['k1', 'k2'] });
          const rows: Row[] = centres.map((centre, i) => ({
            zoneId: zoneId(i),
            sealed: { ciphertext: encode(zoneId(i), 'k1', centre), keyId: 'k1' },
          }));
          const { store } = memoryStore(rows);
          const report = await rotateZoneCentreKeys({ store, cipher, activeKeyId: 'k2' }, RUN);
          const text = JSON.stringify(report);
          for (const [i, centre] of centres.entries()) {
            expect(text).not.toContain(String(centre.lat));
            expect(text).not.toContain(String(centre.lon));
            expect(text).not.toContain(zoneId(i));
          }
          expect(text).not.toMatch(/[0-9a-f]{16}/);
        },
      ),
      { numRuns: 50 },
    );
  });
});
