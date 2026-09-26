/**
 * The NRT-lag store and the parity reader against a real Postgres (TASKS C9; migration 008).
 *
 * What only the database can prove: that the `integer[]` literals survive the `unnest`
 * upsert and come back as arrays; that a re-recorded day replaces its row; that a digest
 * changed under the same version is refused rather than silently overwriting counts; that
 * migration 008's CHECKs reject the rows the core can never produce; that the sample
 * reader's `available_at` window and SP exclusion hold in SQL; and that the parity
 * reader's tier, window and source filters do too.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DailyLagHistogram } from '../../core/ingest/lag-histogram.js';
import { NRT_LAG_HISTOGRAM } from '../../core/ingest/lag-histogram-params.js';
import { recordLagHistograms } from '../../core/ingest/lag-recorder.js';
import { VirtualClock } from '../../core/ports/clock.js';
import {
  createPgLagHistogramStore,
  type PgLagHistogramQueryable,
} from './pg-lag-histogram-store.js';
import { createPgParityReader, type PgParityQueryable } from './pg-parity-reader.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The lag-histogram SQL ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const SNPP = 'firms:viirs:snpp';
const NOAA20 = 'firms:viirs:noaa20';
const DAY = '2026-08-20';
const DAY_WINDOW = {
  fromMs: Date.parse('2026-08-20T00:00:00Z'),
  toMs: Date.parse('2026-08-21T00:00:00Z'),
};

const uid = (n: number): string => n.toString(16).padStart(64, '0');

describe.skipIf(!hasDocker)('the lag-histogram store and the parity reader', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let store: ReturnType<typeof createPgLagHistogramStore>;
  let parity: ReturnType<typeof createPgParityReader>;

  async function insertDetection(
    n: number,
    fields: {
      source?: string;
      tier?: 'NRT' | 'SP' | 'GEO';
      acqTs: string;
      availableAt: string;
      quarantined?: boolean;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO detections (
         detection_uid, source, product_tier, acq_ts, available_at, lat, lon,
         confidence_raw, confidence, source_registry_version, ingest_config_version, quarantined
       ) VALUES ($1, $2, $3, $4, $5, 42.6, 25.1, 'n', 'nominal', $6, 'ingest_v1', $7)`,
      [
        uid(n),
        fields.source ?? SNPP,
        fields.tier ?? 'NRT',
        fields.acqTs,
        fields.availableAt,
        SOURCE_REGISTRY_VERSION,
        fields.quarantined ?? false,
      ],
    );
  }

  function row(overrides: Partial<DailyLagHistogram['histogram']> = {}): DailyLagHistogram {
    const edges = [...NRT_LAG_HISTOGRAM.values.edgesMinutes];
    const counts = edges.slice(1).map(() => 0);
    counts[1] = 2;
    return {
      day: DAY,
      histogram: {
        source: SNPP,
        histogramVersion: NRT_LAG_HISTOGRAM.version,
        histogramDigest: NRT_LAG_HISTOGRAM.digest,
        edgesMinutes: edges,
        counts,
        below: 0,
        overflow: 1,
        total: 3,
        minLagMs: 1_900_000,
        maxLagMs: 200_000_000,
        ...overrides,
      },
    };
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
    // A `Client` satisfies both declared slices of pg; if either stops type-checking, an
    // adapter grew a dependency on something wider than it says.
    const storeDb: PgLagHistogramQueryable = db;
    const parityDb: PgParityQueryable = db;
    store = createPgLagHistogramStore(storeDb);
    parity = createPgParityReader(parityDb);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM nrt_lag_histograms');
    await db.query('DELETE FROM detections');
  });

  describe('nrt_lag_histograms', () => {
    it('round-trips a row, arrays and bigint extrema included', async () => {
      expect(await store.upsertDaily([row()])).toBe(1);

      const back = await store.loadDaily({
        fromDay: DAY,
        toDay: DAY,
        histogramVersion: NRT_LAG_HISTOGRAM.version,
      });
      expect(back).toEqual([row()]);
    });

    it('replaces the row when the same day is recorded again', async () => {
      await store.upsertDaily([row()]);
      const counts = row().histogram.counts.map((_, i) => (i === 0 ? 5 : 0));
      // All five lags in the first (0–30 min) bin, so both extrema move with them.
      await store.upsertDaily([
        row({ counts, overflow: 0, total: 5, minLagMs: 30_000, maxLagMs: 60_000 }),
      ]);

      const back = await store.loadDaily({
        fromDay: DAY,
        toDay: DAY,
        histogramVersion: NRT_LAG_HISTOGRAM.version,
      });
      expect(back).toHaveLength(1);
      expect(back[0]?.histogram).toMatchObject({ counts, overflow: 0, total: 5 });
    });

    it('refuses to overwrite a row stored under the same version with another digest', async () => {
      await store.upsertDaily([row()]);
      await expect(
        store.upsertDaily([row({ histogramDigest: 'edited-in-place', total: 9, overflow: 7 })]),
      ).rejects.toThrow(/different digest/);

      const { rows } = await db.query<{ total: number }>('SELECT total FROM nrt_lag_histograms');
      expect(rows).toEqual([{ total: 3 }]);
    });

    it('reads an inclusive day range of one version, sorted by day then source', async () => {
      await store.upsertDaily([
        { ...row({ source: SNPP }), day: '2026-08-21' },
        row({ source: SNPP }),
        row({ source: NOAA20 }),
        { ...row(), day: '2026-08-22' },
      ]);

      const back = await store.loadDaily({
        fromDay: DAY,
        toDay: '2026-08-21',
        histogramVersion: NRT_LAG_HISTOGRAM.version,
      });
      expect(back.map((r) => `${r.day} ${r.histogram.source}`)).toEqual([
        `${DAY} ${NOAA20}`,
        `${DAY} ${SNPP}`,
        `2026-08-21 ${SNPP}`,
      ]);
      expect(
        await store.loadDaily({ fromDay: DAY, toDay: DAY, histogramVersion: 'other_v1' }),
      ).toEqual([]);
    });

    it.each([
      ['counts that do not fit the edges', { counts: [1, 2] }],
      [
        'a negative count',
        { counts: row().histogram.counts.map((c, i) => (i === 0 ? -1 : c)), total: 3 },
      ],
      ['a negative tail', { below: -1 }],
      ['tails above the total', { overflow: 4, total: 3 }],
      [
        'extrema on an empty histogram',
        { total: 0, overflow: 0, counts: row().histogram.counts.map(() => 0) },
      ],
      ['missing extrema on a non-empty one', { minLagMs: null, maxLagMs: null }],
      ['min above max', { minLagMs: 5, maxLagMs: 4 }],
      ['edges not starting at 0', { edgesMinutes: [5, ...row().histogram.edgesMinutes.slice(1)] }],
      ['a malformed version', { histogramVersion: 'NRT-lag' }],
    ])('rejects %s', async (_label, overrides) => {
      await expect(store.upsertDaily([row(overrides)])).rejects.toThrow();
    });
  });

  describe('lag samples', () => {
    it('windows on available_at, excludes SP, and keeps GEO and quarantined rows', async () => {
      await insertDetection(1, {
        acqTs: '2026-08-19T23:30:00Z',
        availableAt: '2026-08-20T00:10:00Z',
      });
      await insertDetection(2, {
        acqTs: '2026-08-20T10:00:00Z',
        availableAt: '2026-08-20T11:00:00Z',
        quarantined: true,
      });
      await insertDetection(3, {
        tier: 'SP',
        acqTs: '2026-06-01T10:00:00Z',
        availableAt: '2026-08-20T12:00:00Z',
      });
      await insertDetection(4, {
        tier: 'GEO',
        acqTs: '2026-08-20T12:00:00Z',
        availableAt: '2026-08-20T12:05:00Z',
      });
      // The window's end is exclusive.
      await insertDetection(5, {
        acqTs: '2026-08-20T23:00:00Z',
        availableAt: '2026-08-21T00:00:00Z',
      });

      const samples = await store.loadLagSamples(DAY_WINDOW);
      expect(samples.map((s) => s.availableAtMs - s.acqTsMs).sort((a, b) => a - b)).toEqual([
        5 * 60_000,
        40 * 60_000,
        60 * 60_000,
      ]);
    });

    it('records a day end to end through the recorder', async () => {
      await insertDetection(1, {
        acqTs: '2026-08-20T10:00:00Z',
        availableAt: '2026-08-20T10:40:00Z',
      });
      await insertDetection(2, {
        source: NOAA20,
        acqTs: '2026-08-20T10:00:00Z',
        availableAt: '2026-08-20T13:00:00Z',
      });
      const deps = {
        reader: store,
        store,
        clock: new VirtualClock('2026-08-21T06:00:00Z'),
        config: NRT_LAG_HISTOGRAM,
      };

      const report = await recordLagHistograms(deps, { days: [DAY] });
      expect(report.rowsWritten).toBe(2);
      // Idempotent: a second run over the same rows replaces, and changes nothing.
      await recordLagHistograms(deps, { days: [DAY] });

      const back = await store.loadDaily({
        fromDay: DAY,
        toDay: DAY,
        histogramVersion: NRT_LAG_HISTOGRAM.version,
      });
      expect(
        back.map((r) => [r.histogram.source, r.histogram.total, r.histogram.maxLagMs]),
      ).toEqual([
        [NOAA20, 1, 3 * 3_600_000],
        [SNPP, 1, 40 * 60_000],
      ]);
    });
  });

  describe('the parity reader', () => {
    it('reads NRT rows of the requested sources inside the acq_ts window only', async () => {
      await insertDetection(1, {
        acqTs: '2026-08-20T10:00:00Z',
        availableAt: '2026-08-20T10:40:00Z',
      });
      await insertDetection(2, {
        acqTs: '2026-08-20T11:00:00Z',
        availableAt: '2026-08-20T11:40:00Z',
        quarantined: true,
      });
      await insertDetection(3, {
        tier: 'SP',
        acqTs: '2026-08-20T12:00:00Z',
        availableAt: '2026-08-22T12:00:00Z',
      });
      await insertDetection(4, {
        source: NOAA20,
        acqTs: '2026-08-20T13:00:00Z',
        availableAt: '2026-08-20T13:40:00Z',
      });
      await insertDetection(5, {
        acqTs: '2026-08-21T00:00:00Z',
        availableAt: '2026-08-21T00:30:00Z',
      });

      const rows = await parity.loadNrtDetections({ sources: [SNPP], window: DAY_WINDOW });
      expect(rows.map((r) => [r.detectionUid, r.quarantined, r.lat, r.lon]).sort()).toEqual([
        [uid(1), false, 42.6, 25.1],
        [uid(2), true, 42.6, 25.1],
      ]);
    });
  });
});
