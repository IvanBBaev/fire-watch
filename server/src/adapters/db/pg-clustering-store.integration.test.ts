/**
 * The live identity pipeline against a real, migrated Postgres: `runIdentityCycle` over
 * `createPgClusteringStore`, end to end. The unit test pins which statements run; only
 * this file proves they are valid against the schema — the identity columns, 004's `seq`
 * trigger, 005's columns and CHECKs, the tuple cursor, the unnest joins — and that the
 * registry a cycle leaves is the one the core planned: a merge tombstones the younger
 * event onto the older one, a replayed cycle writes nothing, the tick watermark moves.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../../core/clustering/clustering-params.js';
import { LIVE_SCORE_CONTEXT } from '../../core/identity/event-scores.js';
import { runIdentityCycle } from '../../core/identity/identity-cycle.js';
import { staticPassPredictor } from '../../core/lifecycle/static-pass-predictor.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { ScoringDetection } from '../../core/scoring/features.js';
import { scoreEvent } from '../../core/scoring/score.js';
import { createPgClusteringStore, type PgClusteringPool } from './pg-clustering-store.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';

const serverDir = fileURLToPath(new URL('../../../', import.meta.url));
const dbmateBin = fileURLToPath(new URL('../../../node_modules/.bin/dbmate', import.meta.url));

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker && process.env['FIRE_WATCH_REQUIRE_DOCKER'] === '1') {
  throw new Error(
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The clustering-store SQL ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const SNPP = 'firms:viirs:snpp';
const T1 = '2026-08-05T03:10:00Z';
const T2 = '2026-08-05T15:10:00Z';
const uid = (n: number): string => n.toString(16).padStart(64, '0');

/** A row `insertBatch` writes, as the scorer reads it: nominal, no day/night, 4.5 MW. */
const scored = (n: number, acq: string, lon: string): ScoringDetection => ({
  detectionUid: uid(n),
  source: SNPP,
  acqTsIso: acq,
  latCanonical: '41.86000',
  lonCanonical: lon,
  confidence: 'nominal',
  dayNight: null,
  frpMw: 4.5,
  scanKm: 0.39,
  trackKm: 0.36,
  overOrAdjacentToWater: null,
});

describe.skipIf(!hasDocker)('the clustering store', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  async function insertBatch(
    availableAt: string,
    detections: readonly { n: number; acq: string; lon: string; quarantined?: boolean }[],
  ): Promise<void> {
    await pool.query(
      `INSERT INTO ingest_batches (
         source, available_at, received, inserted, already_present, rejected, quarantined,
         anomaly_verdict, anomaly_tripped, baseline, ratio,
         ingest_config_version, polling_bbox_version, source_registry_version
       ) VALUES ($1, $2, $3, $3, 0, 0, 0, 'not_enough_history', false, NULL, NULL,
                 'ingest_v1', 'bbox_v1', 'sources_v1')`,
      [SNPP, availableAt, detections.length],
    );
    for (const d of detections) {
      await pool.query(
        `INSERT INTO detections (
           detection_uid, source, product_tier, acq_ts, available_at, lat, lon, scan_km,
           track_km, frp_mw, confidence_raw, confidence, source_registry_version,
           ingest_config_version, quarantined
         ) VALUES ($1, $2, 'NRT', $3, $4, 41.86, $5, 0.39, 0.36, 4.5, 'n', 'nominal',
                   'sources_v1', 'ingest_v1', $6)`,
        [uid(d.n), SNPP, d.acq, availableAt, d.lon, d.quarantined ?? false],
      );
    }
  }

  function cycle(at: string) {
    const store = createPgClusteringStore(pool satisfies PgClusteringPool, CLUSTERING_PARAMS);
    return runIdentityCycle({
      store,
      clock: new VirtualClock(at),
      config: CLUSTERING_PARAMS,
      predictor: staticPassPredictor(),
      maxBatchesPerCycle: 10,
    });
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('seeds one event per separated fire, excludes quarantined rows, and ledgers the batch', async () => {
    await insertBatch(T1, [
      { n: 1, acq: '2026-08-05T00:06:00Z', lon: '26.13000' },
      { n: 9, acq: '2026-08-05T00:06:00Z', lon: '26.50000', quarantined: true },
    ]);
    const report = await cycle('2026-08-05T03:20:00Z');
    expect(report.batches).toMatchObject({ pending: 1, applied: 1, skipped: 0 });
    expect(report.stats).toMatchObject({ detections: 1, seeded: 1 });

    const events = await pool.query<{ status: string; detection_count: number }>(
      'SELECT status, detection_count FROM fire_events',
    );
    expect(events.rows).toEqual([{ status: 'active', detection_count: 1 }]);
    const ledger = await pool.query('SELECT source, detections FROM clustering_batches');
    expect(ledger.rows).toEqual([{ source: SNPP, detections: 1 }]);
    const runs = await pool.query<{ lifecycle_ticked_at: Date | null }>(
      "SELECT lifecycle_ticked_at FROM clustering_runs WHERE kind = 'live'",
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]?.lifecycle_ticked_at?.toISOString()).toBe('2026-08-05T03:20:00.000Z');
  });

  it('writes nothing on a cycle with no new batch', async () => {
    const before = await pool.query('SELECT public_id, seq::text FROM fire_events ORDER BY 1');
    const report = await cycle('2026-08-05T03:30:00Z');
    expect(report.batches.pending).toBe(0);
    const after = await pool.query('SELECT public_id, seq::text FROM fire_events ORDER BY 1');
    expect(after.rows).toEqual(before.rows);
  });

  it('merges a bridged seed into the older event: tombstone, survivor aggregate, FRP', async () => {
    const older = await pool.query<{ public_id: string; seq: string }>(
      'SELECT public_id, seq::text FROM fire_events',
    );
    const olderId = older.rows[0]?.public_id;
    await insertBatch(T2, [
      { n: 2, acq: '2026-08-05T12:06:00Z', lon: '26.10000' },
      { n: 3, acq: '2026-08-05T12:07:00Z', lon: '26.11500' },
    ]);
    const report = await cycle('2026-08-05T15:20:00Z');
    expect(report.stats).toMatchObject({ detections: 2, seeded: 1, merged: 1 });

    const rows = await pool.query<{
      public_id: string;
      merged_into_public_id: string | null;
      detection_count: number;
      sum_frp_mw: number | null;
      seq: string;
    }>(
      `SELECT e.public_id, s.public_id AS merged_into_public_id, e.detection_count,
              e.sum_frp_mw, e.seq::text
         FROM fire_events e LEFT JOIN fire_events s ON s.id = e.merged_into
        ORDER BY e.created_at, e.id`,
    );
    const [survivor, tombstone] = rows.rows;
    expect(survivor).toMatchObject({
      public_id: olderId,
      merged_into_public_id: null,
      detection_count: 3,
      sum_frp_mw: 13.5,
    });
    expect(Number(survivor?.seq)).toBeGreaterThan(Number(older.rows[0]?.seq));
    expect(tombstone).toMatchObject({ merged_into_public_id: olderId, detection_count: 1 });

    // One working-set row survives, holding every member.
    const clusters = await pool.query<{ detection_count: number }>(
      'SELECT detection_count FROM clusters',
    );
    expect(clusters.rows).toEqual([{ detection_count: 3 }]);
    const members = await pool.query(
      `SELECT count(*)::int AS n FROM event_detections ed
         JOIN fire_events e ON e.id = ed.fire_event_id WHERE e.public_id = $1`,
      [olderId],
    );
    expect(members.rows).toEqual([{ n: 3 }]);
  });

  it('persists the v0 score of the merged survivor exactly, and leaves the tombstone unscored', async () => {
    const rows = await pool.query<{
      public_id: string;
      merged: boolean;
      score: number;
      score_params_version: string | null;
      invalidated: boolean;
    }>(
      `SELECT public_id, merged_into IS NOT NULL AS merged, score, score_params_version,
              invalidated
         FROM fire_events ORDER BY created_at, id`,
    );
    const [survivor, tombstone] = rows.rows;
    // Members in canonical (uid) order, as the store reads them back for the scorer.
    const expected = scoreEvent(
      [
        scored(1, '2026-08-05T00:06:00Z', '26.13000'),
        scored(2, '2026-08-05T12:06:00Z', '26.10000'),
        scored(3, '2026-08-05T12:07:00Z', '26.11500'),
      ],
      LIVE_SCORE_CONTEXT,
    );
    // Exact: a 1e-6-quantised score below 1 has at most six significant digits, which a
    // float4 `real` column round-trips — so rewriting an unchanged score is a no-op.
    expect(survivor).toMatchObject({
      merged: false,
      score: expected.score,
      score_params_version: 'score_params_v0',
      invalidated: false,
    });
    expect(expected.score).toBeGreaterThan(0);
    // The absorbed seed was minted a tombstone in the same batch: never scored.
    expect(tombstone).toMatchObject({ merged: true, score: 0, score_params_version: null });
  });

  it('skips a batch another writer already ledgered', async () => {
    const store = createPgClusteringStore(pool satisfies PgClusteringPool, CLUSTERING_PARAMS);
    const run = await store.liveRun(CLUSTERING_PARAMS);
    const value = await store.withBatch(run, { source: SNPP, availableAt: Date.parse(T2) }, () =>
      Promise.resolve('ran'),
    );
    expect(value).toBeNull();
  });
});
