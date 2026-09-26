/**
 * The clustering store against a fake driver: which statements run, in which order, with
 * which bindings, and what the transaction does on every exit path. The integration test
 * proves the SQL itself against the migrated schema; this file pins the contract the core
 * relies on — a skipped batch rolls back and returns `null`, a short row count aborts the
 * whole plan, the ledger row is written last, every client is released.
 */

import type { SourceId } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../../core/clustering/clustering-params.js';
import { clusterBatch, emptyState } from '../../core/clustering/engine.js';
import type { ClusteringDetection, ClusteringState } from '../../core/clustering/types.js';
import { planRegistryWrites } from '../../core/identity/identity-batch.js';
import { epochMsFromIso } from '../../core/ports/clock.js';
import type {
  BatchWrite,
  ClusteringRun,
  EventScore,
  RegistryWrites,
} from '../../core/ports/clustering-store.js';
import { NO_ALIASES } from '../../core/registry/alias-registry.js';
import {
  aggregateArrays,
  createPgClusteringStore,
  hullWkt,
  LIVE_RUN_LOCK_KEY,
  PG_CLUSTERING_SQL as SQL,
  type PgClusteringClient,
} from './pg-clustering-store.js';

const SOURCE: SourceId = 'firms:viirs:snpp';
const T1 = '2026-08-05T03:10:00Z';
const T2 = '2026-08-05T15:10:00Z';
const RUN: ClusteringRun = {
  id: 7,
  kind: 'live',
  configVersion: CLUSTERING_PARAMS.version,
  configDigest: CLUSTERING_PARAMS.digest,
  lifecycleTickedAtMs: null,
};
const BATCH = { source: SOURCE, availableAt: epochMsFromIso(T2) };

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

type Answer = { readonly rows?: readonly unknown[]; readonly rowCount?: number } | Error;

/**
 * One client for every connect. `answer` picks the reply by statement; anything it does
 * not answer gets no rows and a row count equal to the first array binding's length —
 * what a correct write touches — so a test only overrides the replies it is about.
 */
function fakePool(answer: (text: string, values: readonly unknown[]) => Answer | undefined) {
  const queries: Recorded[] = [];
  let connected = 0;
  let released = 0;
  const client: PgClusteringClient = {
    query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      const reply = answer(text, values);
      if (reply instanceof Error) return Promise.reject(reply);
      const firstArray = values.find((v): v is unknown[] => Array.isArray(v));
      return Promise.resolve({
        rows: (reply?.rows ?? []) as Row[],
        rowCount: reply?.rowCount ?? firstArray?.length ?? 1,
      });
    },
    release() {
      released += 1;
    },
  };
  return {
    queries,
    texts: () => queries.map((q) => q.text),
    connected: () => connected,
    released: () => released,
    pool: {
      connect: () => {
        connected += 1;
        return Promise.resolve(client);
      },
    },
  };
}

const store = (pool: { connect(): Promise<PgClusteringClient> }) =>
  createPgClusteringStore(pool, CLUSTERING_PARAMS);

const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: '7',
  kind: 'live',
  config_version: CLUSTERING_PARAMS.version,
  config_digest: CLUSTERING_PARAMS.digest,
  lifecycle_ticked_at: null,
  ...overrides,
});

const uid = (n: number): string => String(n).padStart(64, '0');

function detection(n: number, availableAt: string, acq: string, lon: string): ClusteringDetection {
  return {
    detectionUid: uid(n),
    source: SOURCE,
    availableAt: epochMsFromIso(availableAt),
    acqTsIso: acq,
    latCanonical: '41.86000',
    lonCanonical: lon,
    scanKm: 0.39,
    trackKm: 0.36,
  };
}

function batch(state: ClusteringState, at: string, detections: readonly ClusteringDetection[]) {
  return clusterBatch({ detections, state, now: epochMsFromIso(at), config: CLUSTERING_PARAMS });
}

/**
 * A real plan: one older event, then a batch whose first detection seeds an event the
 * second detection bridges into the older one — a seeded event, an absorbed seed, a
 * tombstone and a survivor aggregate in one write.
 */
function mergingWrite(): BatchWrite {
  const first = batch(emptyState(), T1, [detection(1, T1, '2026-08-05T00:06:00Z', '26.13000')]);
  const result = batch(first.state, T2, [
    detection(2, T2, '2026-08-05T12:06:00Z', '26.10000'),
    detection(3, T2, '2026-08-05T12:07:00Z', '26.11500'),
  ]);
  const writes = planRegistryWrites({
    result,
    aliases: NO_ALIASES,
    candidates: [],
    alertStates: [],
    params: CLUSTERING_PARAMS.values,
    batchAtMs: epochMsFromIso(T2),
  });
  return { batch: BATCH, result, writes, scores: scoresFor(writes) };
}

/** A score per rewritten event, aligned with the aggregates as the port requires. */
function scoresFor(writes: RegistryWrites, score = 0.512345): readonly EventScore[] {
  return writes.aggregates.map((a) => ({
    publicId: a.publicId,
    score,
    invalidated: false,
    paramsVersion: 'score_params_v0',
  }));
}

describe('liveRun', () => {
  it('creates the live run under the advisory lock when none exists', async () => {
    const fake = fakePool((text) =>
      text === SQL.insertLiveRun ? { rows: [runRow({ id: '3' })] } : undefined,
    );
    const run = await store(fake.pool).liveRun(CLUSTERING_PARAMS);
    expect(run).toEqual({ ...RUN, id: 3 });
    expect(fake.texts()).toEqual([
      'BEGIN',
      SQL.lockLiveRuns,
      SQL.selectLiveRuns,
      SQL.insertLiveRun,
      'COMMIT',
    ]);
    expect(fake.queries[1]?.values).toEqual([LIVE_RUN_LOCK_KEY]);
    const [version, digest, params] = fake.queries[3]?.values ?? [];
    expect([version, digest]).toEqual([CLUSTERING_PARAMS.version, CLUSTERING_PARAMS.digest]);
    expect(JSON.parse(String(params))).toEqual(CLUSTERING_PARAMS.values);
    expect(fake.released()).toBe(1);
  });

  it('reuses the existing live run and decodes its tick watermark', async () => {
    const ticked = new Date('2026-08-05T04:00:00Z');
    const fake = fakePool((text) =>
      text === SQL.selectLiveRuns ? { rows: [runRow({ lifecycle_ticked_at: ticked })] } : undefined,
    );
    const run = await store(fake.pool).liveRun(CLUSTERING_PARAMS);
    expect(run.lifecycleTickedAtMs).toBe(ticked.getTime());
    expect(fake.texts()).not.toContain(SQL.insertLiveRun);
  });

  it('refuses a live run produced under another parameter version (a D7 promotion)', async () => {
    const fake = fakePool((text) =>
      text === SQL.selectLiveRuns ? { rows: [runRow({ config_version: 'older' })] } : undefined,
    );
    await expect(store(fake.pool).liveRun(CLUSTERING_PARAMS)).rejects.toThrow(/D7 promotion/);
  });

  it('refuses the same version under a different digest', async () => {
    const fake = fakePool((text) =>
      text === SQL.selectLiveRuns ? { rows: [runRow({ config_digest: 'edited' })] } : undefined,
    );
    await expect(store(fake.pool).liveRun(CLUSTERING_PARAMS)).rejects.toThrow(/edited/);
  });

  it('refuses two live runs and rolls back', async () => {
    const fake = fakePool((text) =>
      text === SQL.selectLiveRuns ? { rows: [runRow(), runRow({ id: '8' })] } : undefined,
    );
    await expect(store(fake.pool).liveRun(CLUSTERING_PARAMS)).rejects.toThrow(/2 live/);
    expect(fake.texts().at(-1)).toBe('ROLLBACK');
    expect(fake.released()).toBe(1);
  });

  it('refuses a config other than the one the store was built for, before connecting', async () => {
    const fake = fakePool(() => undefined);
    await expect(
      store(fake.pool).liveRun({ ...CLUSTERING_PARAMS, digest: 'other' }),
    ).rejects.toThrow(/built for/);
    expect(fake.connected()).toBe(0);
  });
});

describe('pendingBatches', () => {
  it('binds the run, the ISO start bound and the limit, and decodes rows', async () => {
    const at = new Date(T2);
    const fake = fakePool(() => ({ rows: [{ source: SOURCE, available_at: at }] }));
    const pending = await store(fake.pool).pendingBatches(RUN, {
      notBefore: epochMsFromIso(T1),
      limit: 5,
    });
    expect(pending).toEqual([{ source: SOURCE, availableAt: at.getTime() }]);
    expect(fake.queries).toEqual([{ text: SQL.selectPendingBatches, values: [7, T1, 5] }]);
    expect(fake.released()).toBe(1);
  });

  it('compares the cursor as an (available_at, source) tuple in byte order', () => {
    expect(SQL.selectPendingBatches).toContain('b.source COLLATE "C" > c.source COLLATE "C"');
    expect(SQL.selectPendingBatches).toContain('ORDER BY b.available_at, b.source COLLATE "C"');
  });

  it('refuses a non-positive limit', async () => {
    const fake = fakePool(() => undefined);
    await expect(store(fake.pool).pendingBatches(RUN, { notBefore: 0, limit: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects a source outside the registry', async () => {
    const fake = fakePool(() => ({ rows: [{ source: 'nope', available_at: new Date(T2) }] }));
    await expect(
      store(fake.pool).pendingBatches(RUN, { notBefore: 0, limit: 1 }),
    ).rejects.toThrow();
    expect(fake.released()).toBe(1);
  });
});

describe('withBatch', () => {
  it('locks the run, then skips a batch already in the ledger: null, ROLLBACK, no work', async () => {
    const fake = fakePool((text) =>
      text === SQL.selectLedgerEntry ? { rows: [{ '?column?': 1 }] } : undefined,
    );
    let worked = false;
    const value = await store(fake.pool).withBatch(RUN, BATCH, () => {
      worked = true;
      return Promise.resolve('done');
    });
    expect(value).toBeNull();
    expect(worked).toBe(false);
    expect(fake.texts()).toEqual(['BEGIN', SQL.lockRun, SQL.selectLedgerEntry, 'ROLLBACK']);
    expect(fake.queries[2]?.values).toEqual([7, T2, SOURCE]);
    expect(fake.released()).toBe(1);
  });

  it('commits what the work returns', async () => {
    const fake = fakePool(() => undefined);
    const value = await store(fake.pool).withBatch(RUN, BATCH, () => Promise.resolve(42));
    expect(value).toBe(42);
    expect(fake.texts().at(-1)).toBe('COMMIT');
  });

  it('rolls back and releases when the work throws', async () => {
    const fake = fakePool(() => undefined);
    await expect(
      store(fake.pool).withBatch(RUN, BATCH, () => Promise.reject(new Error('engine'))),
    ).rejects.toThrow('engine');
    expect(fake.texts().at(-1)).toBe('ROLLBACK');
    expect(fake.texts()).not.toContain('COMMIT');
    expect(fake.released()).toBe(1);
  });

  it('decodes the batch rows into clustering detections with minute-precision ISO', async () => {
    const fake = fakePool((text) =>
      text === SQL.selectBatchDetections
        ? {
            rows: [
              {
                detection_uid: uid(1),
                source: SOURCE,
                available_at: new Date(T2),
                acq_ts: new Date('2026-08-05T12:06:00.000Z'),
                lat: '41.86000',
                lon: '26.10000',
                scan_km: null,
                track_km: 0.36,
              },
            ],
          }
        : undefined,
    );
    const rows = await store(fake.pool).withBatch(RUN, BATCH, (tx) => tx.loadDetections());
    expect(rows).toEqual([
      {
        detectionUid: uid(1),
        source: SOURCE,
        availableAt: epochMsFromIso(T2),
        acqTsIso: '2026-08-05T12:06:00Z',
        latCanonical: '41.86000',
        lonCanonical: '26.10000',
        scanKm: null,
        trackKm: 0.36,
      },
    ]);
    expect(SQL.selectBatchDetections).toContain('NOT quarantined');
  });

  it('folds working-set rows into clusters and reads the id counter and taken ids', async () => {
    const member = (cluster: string, n: number) => ({
      cluster_id: cluster,
      public_id: `fw-2026-${cluster}aaaa`,
      seed_detection_uid: uid(Number(cluster) * 10),
      minted_at: new Date(T1),
      config_version: 'cv',
      source_registry_version: 'sv',
      detection_uid: uid(n),
      source: SOURCE,
      acq_ts: new Date('2026-08-05T00:06:00Z'),
      lat: '41.86000',
      lon: '26.10000',
      scan_km: 0.39,
      track_km: 0.36,
      frp_mw: 3.5,
    });
    const fake = fakePool((text) => {
      if (text === SQL.selectWorkingSet) {
        return { rows: [member('1', 10), member('1', 11), member('4', 40)] };
      }
      if (text === SQL.selectNextClusterId) return { rows: [{ next_id: '9' }] };
      if (text === SQL.selectPublicIds) return { rows: [{ public_id: 'a' }, { public_id: 'b' }] };
      return undefined;
    });
    const set = await store(fake.pool).withBatch(RUN, BATCH, (tx) =>
      tx.loadWorkingSet(epochMsFromIso(T1)),
    );
    expect(set?.nextClusterId).toBe(9);
    expect(set?.takenPublicIds).toEqual(['a', 'b']);
    expect(set?.clusters.map((c) => [c.id, c.members.length])).toEqual([
      [1, 2],
      [4, 1],
    ]);
    expect(set?.clusters[0]).toMatchObject({
      publicId: 'fw-2026-1aaaa',
      seedDetectionUid: uid(10),
      mintedAt: epochMsFromIso(T1),
      configVersion: 'cv',
      sourceRegistryVersion: 'sv',
    });
    expect(set?.clusters[0]?.members[0]).toEqual({
      detectionUid: uid(10),
      source: SOURCE,
      acqTsIso: '2026-08-05T00:06:00Z',
      latCanonical: '41.86000',
      lonCanonical: '26.10000',
      scanKm: 0.39,
      trackKm: 0.36,
      frpMw: 3.5,
    });
    expect(fake.queries.find((q) => q.text === SQL.selectWorkingSet)?.values).toEqual([7, T1]);
  });

  it('reads aliases as tombstone → survivor', async () => {
    const fake = fakePool((text) =>
      text === SQL.selectAliases ? { rows: [{ tombstone: 't', survivor: 's' }] } : undefined,
    );
    const aliases = await store(fake.pool).withBatch(RUN, BATCH, (tx) => tx.loadAliases());
    expect(aliases).toEqual(new Map([['t', 's']]));
  });

  it('asks for reignition candidates in one statement, radius in metres plus a margin', async () => {
    const fake = fakePool((text) =>
      text === SQL.selectReignitionCandidates
        ? {
            rows: [
              {
                cluster_id: '4',
                public_id: 'fw-x',
                lat: 41.86,
                lon: 26.1,
                started_at: new Date(T1),
                last_detection_at: new Date(T1),
              },
            ],
          }
        : undefined,
    );
    const found = await store(fake.pool).withBatch(RUN, BATCH, async (tx) => ({
      none: await tx.loadCandidates([]),
      some: await tx.loadCandidates([
        {
          at: { lat: 41.9, lon: 26.2 },
          radiusKm: 2,
          notBefore: epochMsFromIso(T1),
          notAfter: epochMsFromIso(T2),
        },
      ]),
    }));
    expect(found?.none).toEqual([]);
    expect(found?.some).toEqual([
      {
        clusterId: 4,
        publicId: 'fw-x',
        centroid: { lat: 41.86, lon: 26.1 },
        startedAt: epochMsFromIso(T1),
        lastDetectionAt: epochMsFromIso(T1),
        fuelBand: null,
      },
    ]);
    const call = fake.queries.filter((q) => q.text === SQL.selectReignitionCandidates);
    expect(call).toHaveLength(1);
    expect(call[0]?.values).toEqual([7, [41.9], [26.2], [2250], [T1], [T2]]);
  });
});

describe('applyBatch', () => {
  it('writes seeds, assignments, tombstones, aggregates, and the ledger row last', async () => {
    const write = mergingWrite();
    const seeded = write.writes.seededEvents[0];
    const tombstone = write.writes.merge.tombstones[0];
    if (seeded === undefined || tombstone === undefined) throw new Error('fixture drifted');
    expect(seeded.absorbed).toBe(true);

    const fake = fakePool((text) =>
      text === SQL.insertSeededEvent ? { rows: [{ id: '41' }] } : undefined,
    );
    await store(fake.pool).withBatch(RUN, BATCH, (tx) => tx.applyBatch(write));

    const texts = fake.texts();
    const order = [
      SQL.insertSeededEvent,
      SQL.insertAssignments,
      SQL.updateTombstones,
      SQL.deleteAbsorbedClusters,
      SQL.updateEventAggregates,
      SQL.updateClusterAggregates,
      SQL.insertLedgerEntry,
    ].map((text) => texts.indexOf(text));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(texts.at(-2)).toBe(SQL.insertLedgerEntry);
    expect(texts.at(-1)).toBe('COMMIT');
    // An absorbed seed gets its registry row and no working-set row.
    expect(texts).not.toContain(SQL.insertCluster);

    const insert = fake.queries.find((q) => q.text === SQL.insertSeededEvent);
    expect(insert?.values.slice(0, 2)).toEqual([seeded.initial.publicId, T2]);
    expect(insert?.values[6]).toBeNull(); // one member: no polygon

    // Every assignment lands on the survivor, including the absorbed seed's own detection.
    const assignments = fake.queries.find((q) => q.text === SQL.insertAssignments);
    expect(assignments?.values[1]).toEqual([
      tombstone.mergedIntoPublicId,
      tombstone.mergedIntoPublicId,
    ]);
    expect(fake.queries.find((q) => q.text === SQL.updateTombstones)?.values).toEqual([
      [tombstone.publicId],
      [tombstone.mergedIntoPublicId],
    ]);

    const ledger = fake.queries.find((q) => q.text === SQL.insertLedgerEntry);
    const stats = write.result.stats;
    expect(ledger?.values).toEqual([
      7,
      SOURCE,
      T2,
      stats.detections,
      stats.seeded,
      stats.attached,
      stats.merged,
      stats.unattached,
      stats.alreadyAssigned,
    ]);
  });

  it('inserts a working-set row for a seed that survives, with the engine seed and mint', async () => {
    const result = batch(emptyState(), T2, [detection(5, T2, '2026-08-05T12:06:00Z', '26.10000')]);
    const writes = planRegistryWrites({
      result,
      aliases: NO_ALIASES,
      candidates: [],
      alertStates: [],
      params: CLUSTERING_PARAMS.values,
      batchAtMs: epochMsFromIso(T2),
    });
    const fake = fakePool((text) =>
      text === SQL.insertSeededEvent ? { rows: [{ id: '41' }] } : undefined,
    );
    await store(fake.pool).withBatch(RUN, BATCH, (tx) =>
      tx.applyBatch({ batch: BATCH, result, writes, scores: scoresFor(writes) }),
    );
    const cluster = fake.queries.find((q) => q.text === SQL.insertCluster);
    expect(cluster?.values[0]).toBe(7);
    expect(cluster?.values[1]).toBe(41);
    expect(cluster?.values.slice(-2)).toEqual([uid(5), T2]);
  });

  it('aborts the whole plan when a write touches fewer rows than it named', async () => {
    const fake = fakePool((text) => {
      if (text === SQL.insertSeededEvent) return { rows: [{ id: '41' }] };
      if (text === SQL.updateTombstones) return { rowCount: 0 };
      return undefined;
    });
    await expect(
      store(fake.pool).withBatch(RUN, BATCH, (tx) => tx.applyBatch(mergingWrite())),
    ).rejects.toThrow(/tombstone write touched 0 rows, expected 1/);
    expect(fake.texts()).not.toContain(SQL.insertLedgerEntry);
    expect(fake.texts().at(-1)).toBe('ROLLBACK');
    expect(fake.released()).toBe(1);
  });

  it('refuses a second applyBatch in the same transaction', async () => {
    const fake = fakePool((text) =>
      text === SQL.insertSeededEvent ? { rows: [{ id: '41' }] } : undefined,
    );
    const write = mergingWrite();
    await expect(
      store(fake.pool).withBatch(RUN, BATCH, async (tx) => {
        await tx.applyBatch(write);
        await tx.applyBatch(write);
      }),
    ).rejects.toThrow(/twice/);
    expect(fake.texts().at(-1)).toBe('ROLLBACK');
  });
});

describe('the D6 score write', () => {
  it('binds score, params version and the override flag in the aggregate arrays', async () => {
    const write = mergingWrite();
    const [survivor] = write.writes.aggregates;
    if (survivor === undefined) throw new Error('fixture drifted');
    const fake = fakePool((text) =>
      text === SQL.insertSeededEvent ? { rows: [{ id: '41' }] } : undefined,
    );
    await store(fake.pool).withBatch(RUN, BATCH, (tx) => tx.applyBatch(write));
    const update = fake.queries.find((q) => q.text === SQL.updateEventAggregates);
    expect(update?.values).toHaveLength(14);
    expect(update?.values.slice(1, 2)).toEqual([[survivor.publicId]]);
    expect(update?.values.slice(11)).toEqual([[0.512345], ['score_params_v0'], [false]]);
    // The cluster statement reads the same arrays; it ignores the score columns.
    const cluster = fake.queries.find((q) => q.text === SQL.updateClusterAggregates);
    expect(cluster?.values).toEqual(update?.values);
  });

  it('writes the score in the aggregate UPDATE and never clears invalidated', () => {
    const text = SQL.updateEventAggregates;
    expect(text).toContain('score = a.score');
    expect(text).toContain('score_params_version = a.score_params_version');
    expect(text).toContain('invalidated = e.invalidated OR a.score_invalidated');
    expect(text).toContain("WHEN a.score_invalidated THEN 'static_source_mask'");
    // Never an explicit seq: 004's trigger draws the one bump for the member change.
    expect(text).not.toMatch(/\bseq\b/);
    expect(SQL.updateClusterAggregates).not.toContain('score =');
  });

  it('refuses scores that do not align with the aggregates, and rolls back', async () => {
    const write = mergingWrite();
    const fake = fakePool((text) =>
      text === SQL.insertSeededEvent ? { rows: [{ id: '41' }] } : undefined,
    );
    await expect(
      store(fake.pool).withBatch(RUN, BATCH, (tx) => tx.applyBatch({ ...write, scores: [] })),
    ).rejects.toThrow(/do not align/);
    expect(fake.texts()).not.toContain(SQL.updateEventAggregates);
    expect(fake.texts().at(-1)).toBe('ROLLBACK');

    const renamed = scoresFor(write.writes).map((s) => ({ ...s, publicId: 'fw-other' }));
    expect(() => aggregateArrays(write.writes.aggregates, renamed, 0.001)).toThrow(/do not align/);
  });

  it('reads scoring rows by (acq_ts, uid) and decodes confidence, day/night and FRP', async () => {
    const fake = fakePool((text) =>
      text === SQL.selectScoringDetections
        ? {
            rows: [
              {
                detection_uid: uid(1),
                source: SOURCE,
                acq_ts: new Date('2026-08-05T12:06:00.000Z'),
                lat: '41.86000',
                lon: '26.10000',
                confidence: 'high',
                day_night: 'N',
                frp_mw: 12.5,
                scan_km: 0.39,
                track_km: null,
              },
            ],
          }
        : undefined,
    );
    const rows = await store(fake.pool).withBatch(RUN, BATCH, (tx) =>
      tx.loadScoringDetections([{ detectionUid: uid(1), acqTsIso: '2026-08-05T12:06:00Z' }]),
    );
    expect(rows).toEqual([
      {
        detectionUid: uid(1),
        source: SOURCE,
        acqTsIso: '2026-08-05T12:06:00Z',
        latCanonical: '41.86000',
        lonCanonical: '26.10000',
        confidence: 'high',
        dayNight: 'N',
        frpMw: 12.5,
        scanKm: 0.39,
        trackKm: null,
        overOrAdjacentToWater: null,
      },
    ]);
    const call = fake.queries.find((q) => q.text === SQL.selectScoringDetections);
    expect(call?.values).toEqual([[uid(1)], ['2026-08-05T12:06:00Z']]);
  });

  it('asks nothing for no keys, and rejects a confidence or day/night outside the enums', async () => {
    const empty = fakePool(() => undefined);
    await expect(
      store(empty.pool).withBatch(RUN, BATCH, (tx) => tx.loadScoringDetections([])),
    ).resolves.toEqual([]);
    expect(empty.texts()).not.toContain(SQL.selectScoringDetections);

    const row = {
      detection_uid: uid(1),
      source: SOURCE,
      acq_ts: new Date('2026-08-05T12:06:00.000Z'),
      lat: '41.86000',
      lon: '26.10000',
      confidence: 'high',
      day_night: 'N',
      frp_mw: null,
      scan_km: null,
      track_km: null,
    };
    const key = [{ detectionUid: uid(1), acqTsIso: '2026-08-05T12:06:00Z' }];
    for (const [bad, pattern] of [
      [{ confidence: 'h' }, /confidence/],
      [{ day_night: 'X' }, /day_night/],
    ] as const) {
      const fake = fakePool((text) =>
        text === SQL.selectScoringDetections ? { rows: [{ ...row, ...bad }] } : undefined,
      );
      await expect(
        store(fake.pool).withBatch(RUN, BATCH, (tx) => tx.loadScoringDetections(key)),
      ).rejects.toThrow(pattern);
    }
  });
});

describe('hullWkt and aggregateArrays', () => {
  const v = (lat: string, lon: string) => ({ latCanonical: lat, lonCanonical: lon });

  it('closes the ring in lon-lat order', () => {
    expect(hullWkt([v('41.1', '26.1'), v('41.2', '26.1'), v('41.2', '26.2')])).toBe(
      'POLYGON((26.1 41.1, 26.1 41.2, 26.2 41.2, 26.1 41.1))',
    );
  });

  it('is null for a point or a segment', () => {
    expect(hullWkt([])).toBeNull();
    expect(hullWkt([v('41.1', '26.1'), v('41.2', '26.1')])).toBeNull();
  });

  it('converts the diameter from integer quanta with the store’s quantum', () => {
    const [survivor] = mergingWrite().writes.aggregates;
    if (survivor === undefined) throw new Error('no aggregate');
    const arrays = aggregateArrays([survivor], scoresFor(mergingWrite().writes), 0.001);
    expect(arrays).toHaveLength(13);
    expect(arrays[8]).toEqual([survivor.hullDiameterQuanta * 0.001]);
    expect(arrays[5]).toEqual([Number(survivor.centroidLatCanonical)]);
  });
});

describe('withTick', () => {
  const tickRow = (publicId: string, n: number, overrides: Record<string, unknown> = {}) => ({
    public_id: publicId,
    status: 'active',
    display_tier: 'map',
    inactive_since: null,
    miss_evidence: 0.5,
    geo_weight_day: new Date('2026-08-05T00:00:00Z'),
    geo_weight_spent: 0.25,
    lifecycle_blind_since: null,
    lifecycle_seen_detection_at: null,
    detection_uid: uid(n),
    source: SOURCE,
    acq_ts: new Date('2026-08-05T12:06:00Z'),
    lat: '41.86000',
    lon: '26.10000',
    scan_km: null,
    track_km: null,
    frp_mw: null,
    ...overrides,
  });

  it('locks the run, exposes the tick watermark, folds events, commits', async () => {
    const ticked = new Date('2026-08-05T04:00:00Z');
    const fake = fakePool((text) => {
      if (text === SQL.lockRun) return { rows: [{ lifecycle_ticked_at: ticked }] };
      if (text === SQL.selectTickEvents) {
        return { rows: [tickRow('a', 1), tickRow('a', 2), tickRow('b', 3)] };
      }
      return undefined;
    });
    const seen = await store(fake.pool).withTick(RUN, async (tx) => ({
      last: tx.lastTickedAtMs,
      events: await tx.loadTickEvents(epochMsFromIso(T1)),
    }));
    expect(seen.last).toBe(ticked.getTime());
    expect(seen.events.map((e) => [e.publicId, e.members.length])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(seen.events[0]).toMatchObject({
      status: 'active',
      displayTier: 'map',
      inactiveSinceMs: null,
      missEvidence: 0.5,
      geoWeightSpent: { utcDayStartMs: epochMsFromIso('2026-08-05T00:00:00Z'), weight: 0.25 },
      seenDetectionAtMs: null,
    });
    expect(fake.texts()[0]).toBe('BEGIN');
    expect(fake.texts()[1]).toBe(SQL.lockRun);
    expect(fake.texts().at(-1)).toBe('COMMIT');
  });

  it('rejects a status or a tier outside the known sets', async () => {
    for (const bad of [{ status: 'smouldering' }, { display_tier: 'banner' }]) {
      const fake = fakePool((text) => {
        if (text === SQL.lockRun) return { rows: [{ lifecycle_ticked_at: null }] };
        if (text === SQL.selectTickEvents) return { rows: [tickRow('a', 1, bad)] };
        return undefined;
      });
      await expect(store(fake.pool).withTick(RUN, (tx) => tx.loadTickEvents(0))).rejects.toThrow(
        /outside/,
      );
      expect(fake.texts().at(-1)).toBe('ROLLBACK');
    }
  });

  it('writes carries as parallel arrays and the watermark', async () => {
    const fake = fakePool((text) =>
      text === SQL.lockRun ? { rows: [{ lifecycle_ticked_at: null }] } : undefined,
    );
    await store(fake.pool).withTick(RUN, async (tx) => {
      await tx.saveCarries([]);
      await tx.saveCarries([
        {
          publicId: 'a',
          missEvidence: 1.5,
          geoWeightSpent: { utcDayStartMs: epochMsFromIso('2026-08-05T00:00:00Z'), weight: 0.5 },
          blindSinceMs: epochMsFromIso('2026-08-04T00:00:00Z'),
          seenDetectionAtMs: epochMsFromIso(T1),
        },
        {
          publicId: 'b',
          missEvidence: 0,
          geoWeightSpent: null,
          blindSinceMs: null,
          seenDetectionAtMs: null,
        },
      ]);
      await tx.markTicked(epochMsFromIso(T2));
    });
    const carries = fake.queries.filter((q) => q.text === SQL.updateCarries);
    expect(carries).toHaveLength(1);
    expect(carries[0]?.values).toEqual([
      ['a', 'b'],
      [1.5, 0],
      ['2026-08-05T00:00:00Z', null],
      [0.5, null],
      [T1, null],
      ['2026-08-04T00:00:00Z', null],
    ]);
    expect(fake.queries.find((q) => q.text === SQL.updateTickedAt)?.values).toEqual([7, T2]);
  });

  it('fails when a carry names an event that is not a live row', async () => {
    const fake = fakePool((text) => {
      if (text === SQL.lockRun) return { rows: [{ lifecycle_ticked_at: null }] };
      if (text === SQL.updateCarries) return { rowCount: 0 };
      return undefined;
    });
    await expect(
      store(fake.pool).withTick(RUN, (tx) =>
        tx.saveCarries([
          {
            publicId: 'gone',
            missEvidence: 0,
            geoWeightSpent: null,
            blindSinceMs: null,
            seenDetectionAtMs: null,
          },
        ]),
      ),
    ).rejects.toThrow(/lifecycle carry/);
  });

  it('fails when the run row is missing', async () => {
    const fake = fakePool(() => undefined);
    await expect(store(fake.pool).withTick(RUN, () => Promise.resolve(1))).rejects.toThrow(
      /does not exist/,
    );
    expect(fake.released()).toBe(1);
  });
});
