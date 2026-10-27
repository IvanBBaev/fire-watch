/**
 * The atomic ingest write against a real PostGIS (TASKS C1, C2).
 *
 * The claim is one Postgres makes and nothing else can: rows appended inside the unit of
 * work are gone when the batch row after them is refused. Without it a poll can leave
 * detections whose `available_at` has no `ingest_batches` row, and the identity pipeline,
 * which queues on that table, never clusters them.
 *
 * The refusal is a real one — a batch row whose verdict and baseline disagree violates
 * `ingest_batches_baseline_matches_verdict` (migration 002) — so the rollback under test
 * is the database's, not a thrown stand-in.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { detectionUid } from '@fire-watch/contracts/node';

import { detectionRecords } from '../../core/ingest/detection-records.js';
import { pollFirmsSource } from '../../core/ingest/firms-poller.js';
import type { DetectionRecord } from '../../core/ports/detection-store.js';
import type { FirmsAreaResponse } from '../../core/ports/firms-client.js';
import type { IngestBatchRecord } from '../../core/ports/quarantine-store.js';
import { createPgIngestBatchWriter, type PgIngestBatchPool } from './pg-ingest-batch-writer.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The atomic ingest write ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const CSV =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight\n' +
  'BGR,41.850123,26.140027,330.5,0.39,0.36,2026-08-02,1124,N,VIIRS,n,2.0NRT,295.1,12.5,D\n' +
  'BGR,41.860123,26.150027,331.5,0.39,0.36,2026-08-02,1124,N,VIIRS,n,2.0NRT,295.1,12.5,D\n';

const AVAILABLE_AT = Date.parse('2026-08-02T11:29:30Z');

async function records(): Promise<readonly DetectionRecord[]> {
  const client = {
    fetchArea: (): Promise<FirmsAreaResponse> =>
      Promise.resolve({ csv: CSV, availableAt: AVAILABLE_AT }),
  };
  return detectionRecords(await pollFirmsSource('firms:viirs:snpp', { client, detectionUid }));
}

function batch(overrides: Partial<IngestBatchRecord> = {}): IngestBatchRecord {
  return {
    source: 'firms:viirs:snpp',
    availableAt: AVAILABLE_AT,
    received: 2,
    inserted: 2,
    alreadyPresent: 0,
    rejected: 0,
    quarantined: 0,
    anomalyVerdict: 'not_enough_history',
    anomalyTripped: false,
    baseline: null,
    ratio: null,
    ingestConfigVersion: 'ingest_anomaly_v1',
    pollingBboxVersion: 'polling_bbox_v1',
    sourceRegistryVersion: 'source_registry_v1',
    ...overrides,
  };
}

describe.skipIf(!hasDocker)('the atomic ingest write', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  async function counts(): Promise<{ detections: number; batches: number }> {
    const { rows } = await pool.query<{ detections: number; batches: number }>(
      `SELECT (SELECT count(*)::int FROM detections) AS detections,
              (SELECT count(*)::int FROM ingest_batches) AS batches`,
    );
    const [row] = rows;
    if (row === undefined) throw new Error('count query returned no row');
    return row;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;

    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE detections, event_detections, ingest_batches');
  });

  it('commits the rows and their batch row together', async () => {
    const writer = createPgIngestBatchWriter(pool satisfies PgIngestBatchPool);
    const toWrite = await records();

    const appended = await writer.withBatch(async (tx) => {
      const result = await tx.appendDetections(toWrite);
      await tx.recordBatch(batch({ inserted: result.inserted }));
      return result;
    });

    expect(appended).toEqual({ received: 2, inserted: 2, alreadyPresent: 0 });
    expect(await counts()).toEqual({ detections: 2, batches: 1 });
  });

  it('leaves neither write behind when the batch row is refused', async () => {
    const writer = createPgIngestBatchWriter(pool);
    const toWrite = await records();

    await expect(
      writer.withBatch(async (tx) => {
        await tx.appendDetections(toWrite);
        // A verdict taken against a baseline, with no baseline: the CHECK refuses it.
        await tx.recordBatch(batch({ anomalyVerdict: 'within_baseline' }));
      }),
    ).rejects.toThrow(/ingest_batches_baseline_matches_verdict/);

    expect(await counts()).toEqual({ detections: 0, batches: 0 });
  });

  it('leaves neither write behind when the work fails after both', async () => {
    const writer = createPgIngestBatchWriter(pool);
    const toWrite = await records();

    await expect(
      writer.withBatch(async (tx) => {
        await tx.appendDetections(toWrite);
        await tx.recordBatch(batch());
        throw new Error('the process died before COMMIT');
      }),
    ).rejects.toThrow('the process died before COMMIT');

    expect(await counts()).toEqual({ detections: 0, batches: 0 });
  });

  it('returns its connection to the pool, so a failed batch does not starve the next', async () => {
    const writer = createPgIngestBatchWriter(pool);
    const toWrite = await records();

    // More failed units of work than the pool has connections: a leaked client would
    // make the last one wait forever.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(writer.withBatch(() => Promise.reject(new Error('refused')))).rejects.toThrow(
        'refused',
      );
    }
    await writer.withBatch(async (tx) => {
      await tx.appendDetections(toWrite);
      await tx.recordBatch(batch());
    });

    expect(await counts()).toEqual({ detections: 2, batches: 1 });
  });
});
