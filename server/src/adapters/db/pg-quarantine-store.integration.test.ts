/**
 * The ingest bookkeeping against a real Postgres (TASKS C2).
 *
 * Almost everything migration 002 claims is a claim about Postgres and nothing else: that
 * a replayed cycle re-records neither its batch nor its quarantine entries, that a batch
 * row whose verdict and baseline disagree is refused rather than stored, and that the
 * process which quarantines a batch cannot later delete the evidence that it did.
 *
 * `UNIQUE NULLS NOT DISTINCT` is the load-bearing one. Under the default NULLS DISTINCT a
 * batch-scope entry — the only kind with a null `row_index` — would be re-appended on every
 * replay, and the quarantine would grow a duplicate per re-run of a cycle nobody re-ran.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { IngestBatchRecord, QuarantineEntry } from '../../core/ports/quarantine-store.js';
import { createPgQuarantineStore, type PgReadable } from './pg-quarantine-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The breaker’s idempotence ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const AVAILABLE_AT = Date.parse('2026-08-02T11:29:30Z');
const TEN_MINUTES = 600_000;

function batch(overrides: Partial<IngestBatchRecord> = {}): IngestBatchRecord {
  return {
    source: 'firms:viirs:snpp',
    availableAt: AVAILABLE_AT,
    received: 2100,
    inserted: 37,
    alreadyPresent: 2063,
    rejected: 0,
    quarantined: 0,
    anomalyVerdict: 'within_baseline',
    anomalyTripped: false,
    baseline: 2000,
    ratio: 1.05,
    ingestConfigVersion: 'ingest_anomaly_v1',
    pollingBboxVersion: 'polling_bbox_v1',
    sourceRegistryVersion: 'source_registry_v1',
    ...overrides,
  };
}

function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    source: 'firms:viirs:snpp',
    availableAt: AVAILABLE_AT,
    scope: 'row',
    rowIndex: 4,
    detectionUid: null,
    reason: 'outside_polling_bbox: (52.10000, 26.14003) lies outside the polled box',
    raw: 'BGR,52.10000,26.140027,330.5,0.39,0.36,2026-08-02,1124,N,VIIRS,n,2.0NRT,295.1,12.5,D',
    ...overrides,
  };
}

interface StoredBatch {
  readonly source: string;
  readonly available_at: Date;
  readonly received: number;
  readonly inserted: number;
  readonly anomaly_verdict: string;
  readonly anomaly_tripped: boolean;
  readonly baseline: string | null;
  readonly ratio: string | null;
  readonly ingest_config_version: string;
}

interface StoredEntry {
  readonly id: string;
  readonly source: string;
  readonly available_at: Date;
  readonly scope: string;
  readonly row_index: number | null;
  readonly detection_uid: string | null;
  readonly reason: string;
  readonly raw: string | null;
}

describe.skipIf(!hasDocker)('the ingest bookkeeping', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let store: ReturnType<typeof createPgQuarantineStore>;

  async function storedBatches(): Promise<StoredBatch[]> {
    const { rows } = await db.query<StoredBatch>(
      'SELECT * FROM ingest_batches ORDER BY source, available_at',
    );
    return rows;
  }

  async function storedEntries(): Promise<StoredEntry[]> {
    const { rows } = await db.query<StoredEntry>(
      'SELECT * FROM ingest_quarantine ORDER BY source, available_at, scope, row_index',
    );
    return rows;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;

    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    // A `Client` is a `PgReadable` — the port is the slice of pg this store uses and
    // nothing wider. If that stops type-checking, the store grew a dependency.
    const readable: PgReadable = db;
    store = createPgQuarantineStore(readable);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE ingest_batches, ingest_quarantine');
  });

  describe('recordBatch', () => {
    it('stores the counts and the verdict a replay would have to reproduce', async () => {
      await store.recordBatch(batch());

      const [stored] = await storedBatches();
      expect(stored).toMatchObject({
        source: 'firms:viirs:snpp',
        received: 2100,
        inserted: 37,
        anomaly_verdict: 'within_baseline',
        anomaly_tripped: false,
        ingest_config_version: 'ingest_anomaly_v1',
      });
      expect(stored?.available_at.toISOString()).toBe('2026-08-02T11:29:30.000Z');
      // `numeric`, so the driver hands them back as text; the value is what matters.
      expect(Number(stored?.baseline)).toBe(2000);
      expect(Number(stored?.ratio)).toBeCloseTo(1.05, 2);
    });

    it('is a no-op the second time the same response is recorded', async () => {
      // A cycle re-run after a crash between the append and the batch record must not add
      // a second history entry — the baseline is the median of exactly these rows.
      await store.recordBatch(batch());
      await store.recordBatch(batch({ received: 999, inserted: 999 }));

      const rows = await storedBatches();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.received).toBe(2100);
    });

    it('refuses a verdict that disagrees with its own baseline', async () => {
      // A wiring bug that never arms the breaker would otherwise show up as a dashboard
      // full of `not_enough_history` months after the season it silently failed to guard.
      await expect(
        store.recordBatch(batch({ anomalyVerdict: 'not_enough_history', baseline: 2000 })),
      ).rejects.toThrow(/baseline_matches_verdict/);
      await expect(
        store.recordBatch(batch({ anomalyVerdict: 'within_baseline', baseline: null })),
      ).rejects.toThrow(/baseline_matches_verdict/);
    });

    it('refuses a trip flag that disagrees with the verdict', async () => {
      await expect(store.recordBatch(batch({ anomalyTripped: true }))).rejects.toThrow(
        /tripped_matches_verdict/,
      );
    });

    it('refuses a batch attributed to a source the registry does not know', async () => {
      // The registry is frozen in `@fire-watch/contracts` and seeded by migration 001, so
      // this can only happen through raw SQL — which is exactly what the FK is there for.
      await expect(
        db.query(
          `INSERT INTO ingest_batches (
             source, available_at, received, inserted, already_present, rejected, quarantined,
             anomaly_verdict, anomaly_tripped, baseline, ratio,
             ingest_config_version, polling_bbox_version, source_registry_version
           ) VALUES ('firms:viirs:noaa99', now(), 0, 0, 0, 0, 0,
                     'not_enough_history', false, NULL, NULL, 'a_v1', 'b_v1', 'c_v1')`,
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe('quarantine', () => {
    it('keeps the delivered bytes verbatim, which is the whole point of the table', async () => {
      const raw = entry().raw;

      await store.quarantine([entry()]);

      const [stored] = await storedEntries();
      expect(stored).toMatchObject({ scope: 'row', row_index: 4, detection_uid: null });
      expect(stored?.raw).toBe(raw);
    });

    it('is a no-op the second time the same rows are quarantined', async () => {
      const entries = [entry(), entry({ rowIndex: 9 })];

      await store.quarantine(entries);
      await store.quarantine(entries);

      expect(await storedEntries()).toHaveLength(2);
    });

    it('records the batch-scope verdict exactly once across replays', async () => {
      // The NULLS NOT DISTINCT case: `row_index` is null here, and under the default
      // NULLS DISTINCT this entry would be re-appended on every re-run.
      const verdict = entry({
        scope: 'batch',
        rowIndex: null,
        raw: null,
        reason: 'above_baseline: 90000 rows against a baseline of 2000 (45×)',
      });

      await store.quarantine([verdict]);
      await store.quarantine([verdict]);

      const rows = await storedEntries();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ scope: 'batch', row_index: null, raw: null });
    });

    it('refuses a row-scope entry that carries no bytes', async () => {
      // Evidence without the evidence. The reason is a summary; the raw line is the record.
      await expect(store.quarantine([entry({ raw: null })])).rejects.toThrow(/row_carries_bytes/);
    });

    it('refuses a batch-scope entry that points at a single row', async () => {
      await expect(store.quarantine([entry({ scope: 'batch', raw: null })])).rejects.toThrow(
        /batch_points_at_nothing/,
      );
    });

    it('stores a whole rejected response in one statement', async () => {
      // The case that matters is the provider re-publishing an archive into the NRT feed:
      // thousands of entries at once, and `unnest` is what keeps that one round trip.
      const entries = Array.from({ length: 5000 }, (_, index) =>
        entry({ rowIndex: index + 1, reason: `row ${String(index + 1)} is outside the box` }),
      );

      await store.quarantine(entries);

      const { rows } = await db.query<{ count: string }>('SELECT count(*) FROM ingest_quarantine');
      expect(Number(rows[0]?.count)).toBe(5000);
    });

    it('truncates a reason that has stopped being a reason', async () => {
      await store.quarantine([entry({ reason: 'x'.repeat(4000) })]);

      const [stored] = await storedEntries();
      expect(stored?.reason).toHaveLength(1001);
    });
  });

  describe('recentBatchSizes', () => {
    async function record(count: number, offset: number, tripped = false): Promise<void> {
      await store.recordBatch(
        batch({
          availableAt: AVAILABLE_AT + offset * TEN_MINUTES,
          received: count,
          ...(tripped ? { anomalyVerdict: 'above_baseline' as const, anomalyTripped: true } : {}),
        }),
      );
    }

    it('reads the newest polls first, capped at the window', async () => {
      await record(1900, 0);
      await record(2000, 1);
      await record(2100, 2);

      expect(await store.recentBatchSizes('firms:viirs:snpp', 2)).toEqual([2100, 2000]);
    });

    it('sees only the source it was asked about', async () => {
      await record(2100, 0);
      await store.recordBatch(batch({ source: 'firms:viirs:noaa20', received: 4200 }));

      expect(await store.recentBatchSizes('firms:viirs:noaa20', 24)).toEqual([4200]);
    });

    it('is empty for a source that has never been polled', async () => {
      expect(await store.recentBatchSizes('firms:viirs:noaa21', 24)).toEqual([]);
    });

    it('includes the batches it tripped on, so the baseline can heal', async () => {
      // Excluding them looks safer and is not: a genuine step change in provider volume
      // would then sit outside the window forever and trip every poll after it.
      await record(2000, 0);
      await record(90_000, 1, true);

      expect(await store.recentBatchSizes('firms:viirs:snpp', 24)).toEqual([90_000, 2000]);
    });
  });

  describe('the append-only grant', () => {
    it('lets the runtime role record evidence and never remove it', async () => {
      // The process that quarantines a batch must not be able to delete the record that
      // it did — the same guarantee the archive itself has (migration 001 §grants).
      await db.query('SET ROLE fire_watch_app');
      try {
        await expect(store.recordBatch(batch())).resolves.toBeUndefined();
        await expect(store.quarantine([entry()])).resolves.toBeUndefined();
        await expect(db.query('UPDATE ingest_batches SET received = 0')).rejects.toThrow(
          /permission denied/,
        );
        await expect(db.query('DELETE FROM ingest_quarantine')).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await db.query('RESET ROLE');
      }

      expect(await storedBatches()).toHaveLength(1);
      expect(await storedEntries()).toHaveLength(1);
    });
  });

  describe('the backup class registry', () => {
    it('classifies both new tables, because an unclassified table is an unbacked one', async () => {
      const { rows } = await db.query<{ table_name: string; class: string }>(
        `SELECT table_name, class FROM table_backup_class
          WHERE table_name IN ('ingest_batches', 'ingest_quarantine')
          ORDER BY table_name`,
      );

      expect(rows).toEqual([
        { table_name: 'ingest_batches', class: 'main' },
        { table_name: 'ingest_quarantine', class: 'main' },
      ]);
    });
  });
});
