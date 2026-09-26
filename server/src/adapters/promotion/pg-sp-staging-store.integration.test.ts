/**
 * The D7 month swap against a real PostGIS, because its claims are claims about
 * Postgres partition behaviour: that a dry run leaves the live partition untouched,
 * that a confirmed swap atomically replaces NRT with SP while retaining the detached
 * partition, and that a failed sanity check aborts before any DDL runs.
 *
 * The month is synthetic — B8's real FIRMS download has not run yet — but the code
 * path is the real one: archive CSV bytes → manifest gate → parser → staging load →
 * observation SQL → sanity gate → DETACH/ATTACH transaction. Each test uses its own
 * month so partition-layout mutations cannot collide.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { detectionUid } from '@fire-watch/contracts/node';

import type { ManifestEntry } from '../../core/backfill/backfill-manifest.js';
import { emptyManifest, renderManifest, withEntry } from '../../core/backfill/backfill-manifest.js';
import type {
  BackfillChunk,
  BackfillJob,
  BACKFILL_PLAN,
} from '../../core/backfill/backfill-plan.js';
import { backfillJob } from '../../core/backfill/backfill-plan.js';
import { POLLING_BBOX } from '../../core/config/polling-bbox.js';
import { defineConfig } from '../../core/config/versioned-config.js';
import type { DetectionRecord } from '../../core/ports/detection-store.js';
import type { MonthRecluster } from '../../core/ports/month-recluster.js';
import type { SpArchiveReader } from '../../core/ports/sp-archive-reader.js';
import { monthWindow } from '../../core/promotion/month-window.js';
import type { PromotionDeps } from '../../core/promotion/promotion-run.js';
import { runPromotion } from '../../core/promotion/promotion-run.js';
import { evaluateSanityChecks } from '../../core/promotion/sanity-checks.js';
import { createPgDetectionStore, type PgQueryable } from '../db/pg-detection-store.js';
import { createOwnerPool } from './pg-owner-pool.js';
import { createPgSpStagingStore, type PromotionPool } from './pg-sp-staging-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The partition swap ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const SOURCE = 'firms:viirs:snpp';
const FETCHED_AT = '2026-08-01T12:00:00Z';

/** A one-month, one-source plan so each test's chunks stay inside its own month. */
function testJob(firstDay: string, lastDay: string): BackfillJob {
  const plan: typeof BACKFILL_PLAN = defineConfig('firms_sp_backfill', 'firms_sp_backfill_t_v1', {
    sources: [{ source: SOURCE, product: 'VIIRS_SNPP_SP', firstDay, lastDay }],
  });
  return backfillJob(plan);
}

const HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';

function row(overrides: Record<string, string> = {}): string {
  const values: Record<string, string> = {
    country_id: 'BGR',
    latitude: '41.850123',
    longitude: '26.140027',
    bright_ti4: '330.5',
    scan: '0.39',
    track: '0.36',
    acq_date: '2020-07-05',
    acq_time: '1124',
    satellite: 'N',
    instrument: 'VIIRS',
    confidence: 'n',
    version: '2.0',
    bright_ti5: '295.1',
    frp: '12.5',
    daynight: 'D',
    ...overrides,
  };
  return HEADER.split(',')
    .map((name) => values[name] ?? '')
    .join(',');
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

function completeEntry(chunk: BackfillChunk): ManifestEntry {
  return {
    source: chunk.source,
    product: chunk.product,
    start_date: chunk.startDate,
    day_range: chunk.dayRange,
    path: chunk.relativePath,
    status: 'complete',
    fetched_at: FETCHED_AT,
    bytes: 1_024,
    sha256: 'a'.repeat(64),
  };
}

/**
 * A fully vouched-for in-memory archive: chunks keyed by start date carry the given
 * CSVs, every other chunk a header-only file. The manifest gate still runs for real.
 */
function monthArchive(job: BackfillJob, byStartDate: Record<string, string>): SpArchiveReader {
  let manifest = emptyManifest(job);
  const files = new Map<string, string>();
  for (const chunk of job.chunks) {
    manifest = withEntry(manifest, chunk.chunkId, completeEntry(chunk));
    files.set(chunk.relativePath, byStartDate[chunk.startDate] ?? csv());
  }
  const manifestText = renderManifest(manifest);
  return {
    readFile: (relativePath) => Promise.resolve(files.get(relativePath) ?? null),
    readManifest: () => Promise.resolve(manifestText),
  };
}

/** A hand-built NRT row for seeding the live partition, uid minted the real way. */
function nrtRecord(acqDate: string, acqTime = '11:24'): DetectionRecord {
  const acqTsIso = `${acqDate}T${acqTime}:00Z`;
  const lat = '41.85012';
  const lon = '26.14003';
  return {
    detectionUid: detectionUid({ source: SOURCE, acqTsIso, lat, lon }),
    source: SOURCE,
    productTier: 'NRT',
    acqTsIso,
    availableAt: Date.parse(acqTsIso) + 300_000,
    lat,
    lon,
    scanKm: 0.39,
    trackKm: 0.36,
    frpMw: 12.5,
    brightnessK: 330.5,
    brightnessBgK: 295.1,
    confidenceRaw: 'n',
    confidence: 'nominal',
    dayNight: 'D',
    collectionVersion: '2.0NRT',
    sourceRegistryVersion: 'source_registry_v1',
    ingestConfigVersion: 'polling_bbox_v1',
    quarantined: false,
  };
}

describe.skipIf(!hasDocker)('the NRT→SP month swap', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let ownerPool: Pool;
  let store: ReturnType<typeof createPgSpStagingStore>;
  let seedStore: ReturnType<typeof createPgDetectionStore>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;

    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const queryable: PgQueryable = db;
    seedStore = createPgDetectionStore(queryable);

    // The real CLI pool: the container's login owns the schema, exactly as the
    // migrations login does in production, so DDL succeeds and the runtime role never
    // could.
    ownerPool = createOwnerPool({ databaseUrl, applicationName: 'fire-watch-sp-promotion-test' });
    const promotionPool: PromotionPool = ownerPool;
    store = createPgSpStagingStore(promotionPool);
  }, 300_000);

  afterAll(async () => {
    await ownerPool?.end();
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE detections, event_detections, source_status');
  });

  function depsFor(
    job: BackfillJob,
    byStartDate: Record<string, string>,
  ): PromotionDeps & {
    reclusteredMonths: string[];
  } {
    const reclusteredMonths: string[] = [];
    const recluster: MonthRecluster = {
      reclusterMonth: (request) => {
        reclusteredMonths.push(request.month);
        return Promise.resolve({ status: 'skipped_no_engine' });
      },
    };
    return {
      archive: monthArchive(job, byStartDate),
      staging: store,
      recluster,
      detectionUid,
      writeLine: () => undefined,
      reclusteredMonths,
    };
  }

  async function count(sql: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(sql);
    return rows[0]?.n ?? -1;
  }

  it('dry-run builds and checks the staging table without touching the live partition', async () => {
    const job = testJob('2020-05-01', '2020-05-31');
    await seedStore.appendDetections([nrtRecord('2020-05-10')]);

    const deps = depsFor(job, {
      '2020-05-01': csv(
        row({ acq_date: '2020-05-10' }),
        row({ acq_date: '2020-05-10', acq_time: '1130' }),
      ),
    });
    const summary = await runPromotion(
      { month: '2020-05', dryRun: true, operatorConfirmed: true },
      job,
      deps,
    );

    expect(summary.decision).toBe('would_swap');
    expect(summary.verdict).toBe('needs_operator'); // the unfitted count band
    expect(summary.stagedRows).toBe(2);
    // The live partition still holds exactly the seeded NRT row and nothing SP.
    expect(await count(`SELECT count(*)::int AS n FROM detections_2020_05`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM detections WHERE product_tier = 'SP'`)).toBe(
      0,
    );
    // The staging table is left behind for inspection, fully loaded.
    expect(await count(`SELECT count(*)::int AS n FROM detections_2020_05_sp_staging`)).toBe(2);
    expect(deps.reclusteredMonths).toEqual([]);
  });

  it('confirmed swap replaces NRT with SP in one transaction and retains the NRT partition', async () => {
    const job = testJob('2020-06-01', '2020-06-30');
    await seedStore.appendDetections([nrtRecord('2020-06-10'), nrtRecord('2020-06-10', '11:30')]);

    const deps = depsFor(job, {
      '2020-06-01': csv(
        row({ acq_date: '2020-06-10' }),
        row({ acq_date: '2020-06-10', acq_time: '1130' }),
        row({ acq_date: '2020-06-10', acq_time: '1136' }),
      ),
    });
    const summary = await runPromotion(
      { month: '2020-06', dryRun: false, operatorConfirmed: true },
      job,
      deps,
    );

    expect(summary.decision).toBe('swapped');
    expect(summary.swap).toEqual({
      retiredTable: 'detections_2020_06_nrt_retired',
      attachedPartition: 'detections_2020_06',
    });
    expect(summary.recluster).toEqual({ status: 'skipped_no_engine' });
    expect(deps.reclusteredMonths).toEqual(['2020-06']);

    // The parent now answers June with the SP rows — the swap is visible through it.
    const { rows } = await db.query<{ product_tier: string; n: number }>(
      `SELECT product_tier, count(*)::int AS n
         FROM detections
        WHERE acq_ts >= '2020-06-01T00:00:00Z' AND acq_ts < '2020-07-01T00:00:00Z'
        GROUP BY product_tier`,
    );
    expect(rows).toEqual([{ product_tier: 'SP', n: 3 }]);

    // A1.4 step 3: the detached NRT partition is retained, not dropped.
    expect(await count(`SELECT count(*)::int AS n FROM detections_2020_06_nrt_retired`)).toBe(2);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM detections_2020_06_nrt_retired WHERE product_tier = 'NRT'`,
      ),
    ).toBe(2);

    // The staging name is gone — the table was renamed into place, not copied.
    const regclass = await db.query<{ oid: string | null }>(
      `SELECT to_regclass('detections_2020_06_sp_staging')::text AS oid`,
    );
    expect(regclass.rows[0]?.oid).toBeNull();
  });

  it('a staged row outside the polling bbox blocks the swap even when confirmed', async () => {
    const job = testJob('2020-07-01', '2020-07-31');
    await seedStore.appendDetections([nrtRecord('2020-07-05')]);

    const deps = depsFor(job, {
      '2020-07-01': csv(row(), row({ latitude: '50.000123', acq_time: '1130' })),
    });
    const summary = await runPromotion(
      { month: '2020-07', dryRun: false, operatorConfirmed: true },
      job,
      deps,
    );

    expect(summary.decision).toBe('blocked_failed');
    expect(summary.report.checks.find((check) => check.check === 'geometry_in_bbox')?.status).toBe(
      'fail',
    );
    // NRT stays live; no partition DDL ran.
    expect(
      await count(`SELECT count(*)::int AS n FROM detections_2020_07 WHERE product_tier = 'NRT'`),
    ).toBe(1);
    const regclass = await db.query<{ oid: string | null }>(
      `SELECT to_regclass('detections_2020_07_nrt_retired')::text AS oid`,
    );
    expect(regclass.rows[0]?.oid).toBeNull();
    expect(deps.reclusteredMonths).toEqual([]);
  });

  it('an NRT source-day with no SP counterpart blocks the swap', async () => {
    const job = testJob('2020-08-01', '2020-08-31');
    await seedStore.appendDetections([nrtRecord('2020-08-05'), nrtRecord('2020-08-06')]);

    // SP covers only the 5th — the 6th went missing from the archive somewhere.
    const deps = depsFor(job, { '2020-08-01': csv(row({ acq_date: '2020-08-05' })) });
    const summary = await runPromotion(
      { month: '2020-08', dryRun: false, operatorConfirmed: true },
      job,
      deps,
    );

    expect(summary.decision).toBe('blocked_failed');
    expect(
      summary.report.checks.find((check) => check.check === 'source_day_coverage')?.status,
    ).toBe('fail');
    expect(
      await count(`SELECT count(*)::int AS n FROM detections_2020_08 WHERE product_tier = 'NRT'`),
    ).toBe(2);
  });

  it('observe counts a duplicated uid inside the staged partition', async () => {
    // Bypasses stageMonth (which deduplicates) to prove the check catches what the
    // pipeline should have made impossible — the observation is measured, not assumed.
    const window = monthWindow('2020-09');
    await store.prepareStaging(window);

    const base = nrtRecord('2020-09-10');
    const staged: DetectionRecord = { ...base, productTier: 'SP' };
    const sameUidLaterTs: DetectionRecord = {
      ...staged,
      acqTsIso: '2020-09-10T11:25:00Z', // different acq_ts, so the PK admits it
    };
    await store.loadStaged(window, [staged, sameUidLaterTs]);

    const observations = await store.observe(window, POLLING_BBOX.values);
    expect(observations.stagedRows).toBe(2);
    expect(observations.stagedDuplicateUids).toBe(1);

    const report = evaluateSanityChecks(observations);
    expect(report.verdict).toBe('fail');
    expect(report.checks.find((check) => check.check === 'uid_uniqueness')?.status).toBe('fail');
  });
});
