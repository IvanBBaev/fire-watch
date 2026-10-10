import { describe, expect, it } from 'vitest';

import { LIGHTNING_CONTEXT_DRIFT } from '../../core/config/lightning-context.js';
import {
  SELECT_CONTEXT,
  SELECT_INCOMPLETE_CONTEXT,
  SELECT_PENDING_CONTEXT,
  UPSERT_CONTEXT,
  createPgLightningContextStore,
  type PgLightningContextQueryable,
} from './pg-lightning-context-store.js';

const T0 = Date.parse('2026-08-05T03:00:00Z');

function fake(answers: Record<string, readonly unknown[]>) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const db: PgLightningContextQueryable = {
    query(text, values = []) {
      calls.push({ text, values });
      const key = Object.keys(answers).find((k) => text === k);
      return Promise.resolve({ rows: key === undefined ? [] : (answers[key] ?? []) });
    },
  };
  return { db, calls };
}

describe('the pg lightning context store', () => {
  it('decodes pending candidates with what their row was computed for', async () => {
    const { db, calls } = fake({
      [SELECT_PENDING_CONTEXT]: [
        { id: '12', lat: 42.6, lon: 25.1, started_at: new Date(T0), status: null },
        {
          id: '13',
          lat: 42.7,
          lon: 25.2,
          started_at: new Date(T0),
          status: 'complete',
          params_version: 'lightning_context_v1',
          window_to: new Date(T0 - 1),
          centroid_lat: 42.5,
          centroid_lon: 25.0,
        },
      ],
    });
    const pending = await createPgLightningContextStore(db).pendingEvents(
      'lightning_context_v1',
      5,
      LIGHTNING_CONTEXT_DRIFT,
    );
    expect(pending).toEqual([
      { eventId: '12', lat: 42.6, lon: 25.1, firstDetectedAt: T0, previous: null },
      {
        eventId: '13',
        lat: 42.7,
        lon: 25.2,
        firstDetectedAt: T0,
        previous: {
          status: 'complete',
          paramsVersion: 'lightning_context_v1',
          windowTo: T0 - 1,
          lat: 42.5,
          lon: 25.0,
        },
      },
    ]);
    expect(calls[0]?.values).toEqual(['lightning_context_v1', '5', 1, 60_000]);
  });

  it('lists incomplete events detected before a cut-off', async () => {
    const { db, calls } = fake({
      [SELECT_INCOMPLETE_CONTEXT]: [
        { id: '12', lat: 42.6, lon: 25.1, started_at: new Date(T0), status: null },
      ],
    });
    const incomplete = await createPgLightningContextStore(db).incompleteEvents(
      'lightning_context_v1',
      T0 + 1,
      7,
      LIGHTNING_CONTEXT_DRIFT,
    );
    expect(incomplete).toHaveLength(1);
    expect(calls[0]?.values).toEqual(['lightning_context_v1', '7', 1, 60_000, new Date(T0 + 1)]);
  });

  it('refuses a non-positive limit and an unknown stored status', async () => {
    const { db } = fake({});
    const store = createPgLightningContextStore(db);
    await expect(store.pendingEvents('v', 0, LIGHTNING_CONTEXT_DRIFT)).rejects.toThrow(RangeError);
    await expect(store.incompleteEvents('v', T0, 0, LIGHTNING_CONTEXT_DRIFT)).rejects.toThrow(
      RangeError,
    );
    const odd = fake({
      [SELECT_PENDING_CONTEXT]: [
        { id: '1', lat: 0, lon: 0, started_at: new Date(T0), status: 'pending' },
      ],
    });
    await expect(
      createPgLightningContextStore(odd.db).pendingEvents('v', 1, LIGHTNING_CONTEXT_DRIFT),
    ).rejects.toThrow(/unknown value/);
  });

  it('upserts one statement per row with timestamps as dates', async () => {
    const { db, calls } = fake({});
    await createPgLightningContextStore(db).save([
      {
        eventId: '12',
        status: 'unavailable',
        windowFrom: T0 - 1,
        windowTo: T0,
        radiusKm: 10,
        lat: 42.6,
        lon: 25.1,
        flashCount: null,
        nearestKm: null,
        paramsVersion: 'lightning_context_v1',
        filterVersion: 'none',
        computedAt: T0 + 1,
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe(UPSERT_CONTEXT);
    expect(calls[0]?.values[2]).toEqual(new Date(T0 - 1));
    expect(calls[0]?.values.slice(10)).toEqual([42.6, 25.1]);
  });

  it('answers unknown for an id with no chain, and rounds real columns to a tenth', async () => {
    const empty = fake({});
    expect(await createPgLightningContextStore(empty.db).readLightningContext('x')).toEqual({
      kind: 'unknown',
    });
    const { db } = fake({
      [SELECT_CONTEXT]: [
        {
          started_at: new Date(T0),
          status: 'complete',
          window_from: new Date(T0 - 1),
          window_to: new Date(T0),
          radius_km: 10,
          flash_count: 2,
          nearest_km: 5.599999904632568,
          params_version: 'lightning_context_v1',
          filter_version: 'lightning_filter_v1',
          computed_at: new Date(T0 + 1),
          centroid_lat: 42.6,
          centroid_lon: 25.1,
        },
      ],
    });
    const chainDb: PgLightningContextQueryable = {
      query: (text, values) =>
        text.includes('WITH RECURSIVE')
          ? Promise.resolve({ rows: [{ id: '12', merged_into: null }] })
          : db.query(text, values),
    };
    const read = await createPgLightningContextStore(chainDb).readLightningContext('fw-2026-aaaaa');
    expect(read).toMatchObject({
      kind: 'event',
      firstDetectedAt: T0,
      row: { nearestKm: 5.6, lat: 42.6 },
    });
  });
});
