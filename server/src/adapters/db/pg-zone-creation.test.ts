import { randomBytes } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AlertableEvent } from '../../core/alerts/alert-decision.js';
import { epochMsFromIso } from '../../core/ports/clock.js';
import {
  NO_SEED_CANDIDATES,
  type ZoneSeedCandidateReader,
} from '../../core/ports/zone-seed-candidate-reader.js';
import { coarsenCentre } from '../../core/zones/zone-geometry.js';
import { createAesGcmZoneCipher } from '../crypto/aes-gcm-zone-cipher.js';
import { ALERT_DECISION_LOG_SQL } from './pg-alert-decision-log.js';
import { WATCH_ZONE_SQL } from './pg-watch-zone-store.js';
import { ZONE_SEED_CANDIDATE_SQL } from './pg-zone-seed-candidate-reader.js';
import { createPgZoneCreator, type PgZoneCreationClient } from './pg-zone-creation.js';

const ACCOUNT = '55555555-0000-4000-8000-000000000001';
const ZONE = '55555555-0000-4000-8000-0000000000aa';
const AT = epochMsFromIso('2026-08-20T05:20:00Z');
const HOUR = 3_600_000;
const CIPHER = createAesGcmZoneCipher({
  active: { id: 'k2026a', key: randomBytes(32) },
  retired: [],
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * One fake client for the whole transaction. It answers the account-settings read with a
 * live account and every write with the row count the store expects; everything it is
 * sent is recorded, which is what the no-plaintext property below inspects.
 */
function fakePool(options: { readonly failOn?: RegExp } = {}) {
  const queries: RecordedQuery[] = [];
  let released = 0;
  const client: PgZoneCreationClient = {
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      if (options.failOn?.test(text) === true) return Promise.reject(new Error('boom'));
      if (text === WATCH_ZONE_SQL.selectAccountSettings) {
        return Promise.resolve({
          rows: [
            {
              timezone: 'Europe/Sofia',
              quiet_hours_start: '22:00',
              quiet_hours_end: '07:00',
              new_fire_overrides_quiet_hours: true,
            },
          ] as unknown as Row[],
          rowCount: 1,
        });
      }
      const count = Array.isArray(values[0]) ? values[0].length : 1;
      return Promise.resolve({ rows: [] as Row[], rowCount: count });
    },
    release() {
      released += 1;
    },
  };
  return {
    queries,
    released: () => released,
    pool: { connect: () => Promise.resolve(client) },
  };
}

function burningEvent(publicId: string): AlertableEvent {
  return {
    publicId,
    score: 0.8,
    detectionCount: 3,
    nightHighConfidenceCount: 0,
    geoOnly: false,
    invalidated: false,
    quarantined: false,
    status: 'active',
    statusBefore: null,
    relationKind: null,
    burnedAreaHa: null,
    startedAt: AT - 48 * HOUR,
    lastDetectionAt: AT - HOUR,
  };
}

/**
 * Every encoding a coordinate could take in a bound value: the number itself, its decimal
 * text, and its IEEE-754 bytes in either byte order.
 */
function leaks(values: readonly unknown[], coordinate: number): boolean {
  const be = Buffer.alloc(8);
  be.writeDoubleBE(coordinate);
  const le = Buffer.from(be).reverse();
  const text = String(coordinate);
  const inspect = (value: unknown): boolean => {
    if (typeof value === 'number') return value === coordinate;
    if (typeof value === 'string') return value.includes(text);
    if (value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      return bytes.includes(be) || bytes.includes(le) || bytes.includes(Buffer.from(text));
    }
    if (Array.isArray(value)) return value.some(inspect);
    return false;
  };
  return values.some(inspect);
}

describe('the stored row (I2 "done when")', () => {
  it('contains neither the click nor the stored centre, in any encoding, for any centre', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.double({ min: 41.3, max: 44.1, noNaN: true }),
        fc.double({ min: 22.5, max: 28.5, noNaN: true }),
        fc.boolean(),
        async (lat, lon, coarsen) => {
          const fake = fakePool();
          // The default pg reader, so its bound values are inspected too.
          const create = createPgZoneCreator(fake.pool, { cipher: CIPHER, newZoneId: () => ZONE });
          const created = await create(
            { accountId: ACCOUNT, name: 'Home', centre: { lat, lon }, coarsen },
            AT,
          );
          const insert = fake.queries.find((q) => q.text === WATCH_ZONE_SQL.insertZone);
          expect(insert).toBeDefined();
          for (const coordinate of [lat, lon, created.storedCentre.lat, created.storedCentre.lon]) {
            expect(leaks(insert?.values ?? [], coordinate)).toBe(false);
          }
          // Nor does any other statement of the transaction — the seed read included.
          for (const query of fake.queries) {
            if (query === insert) continue;
            for (const coordinate of [
              lat,
              lon,
              created.storedCentre.lat,
              created.storedCentre.lon,
            ]) {
              expect(leaks(query.values, coordinate)).toBe(false);
            }
          }
          // …and yet the row opens to exactly the stored centre, which is coarsened when on.
          const ciphertext = insert?.values[5] as Buffer;
          const opened = CIPHER.open(ZONE, { ciphertext, keyId: 'k2026a' });
          expect(opened).toEqual(coarsen ? coarsenCentre({ lat, lon }) : { lat, lon });
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('the transaction', () => {
  it('writes the zone and its A1.8 seed between one BEGIN and one COMMIT', async () => {
    const fake = fakePool();
    const reader: ZoneSeedCandidateReader = {
      candidatesWithin: () =>
        Promise.resolve([
          { event: burningEvent('fw-2026-a1b2c'), distanceKm: 3, fireEventId: '10', seq: '4' },
        ]),
    };
    const create = createPgZoneCreator(fake.pool, {
      cipher: CIPHER,
      candidateReaderFor: () => reader,
      newZoneId: () => ZONE,
    });
    const created = await create(
      { accountId: ACCOUNT, name: 'Home', centre: { lat: 42.69751, lon: 23.32415 } },
      AT,
    );
    const texts = fake.queries.map((q) => q.text.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(texts[0]).toBe('BEGIN');
    expect(texts.at(-1)).toBe('COMMIT');
    expect(texts.filter((t) => t === 'BEGIN' || t === 'COMMIT')).toHaveLength(2);
    expect(fake.queries.some((q) => q.text.includes('INSERT INTO alert_states'))).toBe(true);
    expect(created.seed.upserts).toHaveLength(1);
    expect(fake.released()).toBe(1);
  });

  it('appends the seed pass to the H7 decision log inside the same transaction', async () => {
    const fake = fakePool();
    const reader: ZoneSeedCandidateReader = {
      candidatesWithin: () =>
        Promise.resolve([
          { event: burningEvent('fw-2026-a1b2c'), distanceKm: 3, fireEventId: '10', seq: '4' },
        ]),
    };
    const create = createPgZoneCreator(fake.pool, {
      cipher: CIPHER,
      candidateReaderFor: () => reader,
      newZoneId: () => ZONE,
    });
    await create({ accountId: ACCOUNT, name: 'Home', centre: { lat: 42.7, lon: 23.3 } }, AT);
    const texts = fake.queries.map((q) => q.text);
    const append = texts.indexOf(ALERT_DECISION_LOG_SQL.append);
    expect(append).toBeGreaterThan(texts.indexOf('BEGIN'));
    expect(append).toBeLessThan(texts.indexOf('COMMIT'));
    const values = fake.queries[append]?.values ?? [];
    expect(values.slice(0, 7)).toEqual([
      [ZONE],
      ['10'],
      ['4'],
      ['zone_creation'],
      ['seed'],
      ['pre_existing_event'],
      [expect.any(String)],
    ]);
  });

  it('reads seed candidates through the pg reader by default, on the same client', async () => {
    const fake = fakePool();
    const create = createPgZoneCreator(fake.pool, { cipher: CIPHER, newZoneId: () => ZONE });
    await create({ accountId: ACCOUNT, name: 'Home', centre: { lat: 42.7, lon: 23.3 } }, AT);
    const texts = fake.queries.map((q) => q.text);
    const read = texts.indexOf(ZONE_SEED_CANDIDATE_SQL.selectCandidates);
    expect(read).toBeGreaterThan(texts.indexOf(WATCH_ZONE_SQL.insertZone));
    expect(read).toBeLessThan(texts.indexOf('COMMIT'));
  });

  it('rolls the zone back when the seed write fails, so no unseeded zone survives', async () => {
    const fake = fakePool({ failOn: /INSERT INTO alert_states/ });
    const reader: ZoneSeedCandidateReader = {
      candidatesWithin: () =>
        Promise.resolve([
          { event: burningEvent('fw-2026-a1b2c'), distanceKm: 3, fireEventId: '10', seq: '4' },
        ]),
    };
    const create = createPgZoneCreator(fake.pool, {
      cipher: CIPHER,
      candidateReaderFor: () => reader,
      newZoneId: () => ZONE,
    });
    await expect(
      create({ accountId: ACCOUNT, name: 'Home', centre: { lat: 42.7, lon: 23.3 } }, AT),
    ).rejects.toThrow('boom');
    const texts = fake.queries.map((q) => q.text.trim());
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
    expect(fake.released()).toBe(1);
  });

  it('rolls back and releases on a refusal too', async () => {
    const fake = fakePool();
    const create = createPgZoneCreator(fake.pool, {
      cipher: CIPHER,
      candidateReaderFor: () => NO_SEED_CANDIDATES,
      newZoneId: () => ZONE,
    });
    await expect(
      create({ accountId: ACCOUNT, name: 'Home', centre: { lat: 51.5, lon: -0.1 } }, AT),
    ).rejects.toMatchObject({ code: 'outside_area' });
    expect(fake.queries.map((q) => q.text.trim())).toEqual(['BEGIN', 'ROLLBACK']);
    expect(fake.released()).toBe(1);
  });
});
