/**
 * The ingest write path against a real PostGIS, because every claim it makes is a claim
 * about Postgres behaviour: that a re-polled row is a no-op, that the archive cannot be
 * rewritten by the role that writes it, and that a row outside the partition range fails
 * loudly instead of vanishing into a default partition.
 *
 * The chain under test is the real one — CSV bytes → parser → poll run → records → SQL —
 * so a mapping that drifts from the schema fails here rather than in production.
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

import { detectionUid } from '@fire-watch/contracts/node';

import { detectionRecords, pollAttempt } from '../../core/ingest/detection-records.js';
import { pollFirmsSource, type FirmsPollRun } from '../../core/ingest/firms-poller.js';
import type { DetectionRecord } from '../../core/ports/detection-store.js';
import type { FirmsAreaResponse } from '../../core/ports/firms-client.js';
import { createPgDetectionStore, type PgQueryable } from './pg-detection-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The ingest write path ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
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
    acq_date: '2026-08-02',
    acq_time: '1124',
    satellite: 'N',
    instrument: 'VIIRS',
    confidence: 'n',
    version: '2.0NRT',
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

/** Runs the live poll path over a canned response, exactly as a cycle would. */
async function poll(body: string, availableAt: number): Promise<FirmsPollRun> {
  const client = {
    fetchArea: (): Promise<FirmsAreaResponse> => Promise.resolve({ csv: body, availableAt }),
  };
  return pollFirmsSource('firms:viirs:snpp', { client, detectionUid });
}

const AVAILABLE_AT = Date.parse('2026-08-02T11:29:30Z');

/** The single record of a one-row poll, with the emptiness checked rather than asserted. */
function onlyRecord(run: FirmsPollRun): DetectionRecord {
  const [record] = detectionRecords(run);
  if (record === undefined) throw new Error('expected the poll to produce exactly one record');
  return record;
}

interface StoredDetection {
  readonly detection_uid: string;
  readonly source: string;
  readonly product_tier: string;
  readonly acq_ts: Date;
  readonly available_at: Date;
  readonly ingested_at: Date;
  readonly lat: string;
  readonly lon: string;
  readonly scan_km: number | null;
  readonly frp_mw: number | null;
  readonly confidence: string;
  readonly confidence_raw: string;
  readonly day_night: string | null;
  readonly collection_version: string | null;
  readonly source_registry_version: string;
  readonly ingest_config_version: string;
  readonly quarantined: boolean;
  readonly geom_text: string;
}

describe.skipIf(!hasDocker)('the ingest write path', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let store: ReturnType<typeof createPgDetectionStore>;

  async function storedDetections(): Promise<StoredDetection[]> {
    const { rows } = await db.query<StoredDetection>(
      `SELECT d.*, ST_AsText(d.geom) AS geom_text
         FROM detections d
        ORDER BY d.available_at, d.source, d.lat, d.lon, d.detection_uid`,
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
    // A `Client` is a `PgQueryable` — the port is the slice of pg the store uses, and
    // nothing wider. If that ever stops type-checking, the store grew a dependency.
    const queryable: PgQueryable = db;
    store = createPgDetectionStore(queryable);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE detections, source_status');
  });

  describe('appendDetections', () => {
    it('stores a polled row with the provenance needed to explain it later', async () => {
      const run = await poll(csv(row()), AVAILABLE_AT);

      const result = await store.appendDetections(detectionRecords(run));

      expect(result).toEqual({ received: 1, inserted: 1, alreadyPresent: 0 });
      const [stored] = await storedDetections();
      expect(stored).toMatchObject({
        source: 'firms:viirs:snpp',
        product_tier: 'NRT',
        confidence: 'nominal',
        confidence_raw: 'n',
        day_night: 'D',
        collection_version: '2.0NRT',
        source_registry_version: 'source_registry_v1',
        ingest_config_version: 'polling_bbox_v1',
      });
      expect(stored?.acq_ts.toISOString()).toBe('2026-08-02T11:24:00.000Z');
      expect(stored?.available_at.toISOString()).toBe('2026-08-02T11:29:30.000Z');
      expect(stored?.detection_uid).toMatch(/^[0-9a-f]{64}$/);
    });

    it('round-trips the coordinates as the exact text that was hashed', async () => {
      // `numeric(8,5)` keeps the five decimals; `double precision` would not, and the
      // uid would then stop being recomputable from the stored columns.
      const run = await poll(csv(row({ latitude: '41.85', longitude: '-0.100004' })), AVAILABLE_AT);

      await store.appendDetections(detectionRecords(run));

      const [stored] = await storedDetections();
      expect(stored?.lat).toBe('41.85000');
      expect(stored?.lon).toBe('-0.10000');
      expect(stored?.geom_text).toBe('POINT(-0.1 41.85)');
      expect(stored?.detection_uid).toBe(
        detectionUid({
          source: 'firms:viirs:snpp',
          acqTsIso: '2026-08-02T11:24:00Z',
          lat: '41.85000',
          lon: '-0.10000',
        }),
      );
    });

    it('is a no-op the second time the same poll lands', async () => {
      // C1's done-when clause. `day_range=2` re-delivers yesterday's rows on purpose,
      // so this is not an edge case — it is what every single cycle does.
      const run = await poll(csv(row(), row({ acq_time: '1130' })), AVAILABLE_AT);
      const records = detectionRecords(run);

      const first = await store.appendDetections(records);
      const before = await storedDetections();
      const second = await store.appendDetections(records);
      const after = await storedDetections();

      expect(first).toEqual({ received: 2, inserted: 2, alreadyPresent: 0 });
      expect(second).toEqual({ received: 2, inserted: 0, alreadyPresent: 2 });
      expect(after).toEqual(before);
    });

    it('inserts only what is new when the window overlaps', async () => {
      const first = await poll(csv(row()), AVAILABLE_AT);
      await store.appendDetections(detectionRecords(first));

      const second = await poll(csv(row(), row({ acq_time: '1218' })), AVAILABLE_AT + 600_000);
      const result = await store.appendDetections(detectionRecords(second));

      expect(result).toEqual({ received: 2, inserted: 1, alreadyPresent: 1 });
      expect(await storedDetections()).toHaveLength(2);
    });

    it('keeps the first observation when a later one reprocesses the same detection', async () => {
      // Pitfall 6: NRT rows are reissued as SP with adjusted values. A1.1 discards the
      // reissue rather than merging it — the archive records what we saw when we saw it.
      const run = await poll(csv(row()), AVAILABLE_AT);
      await store.appendDetections(detectionRecords(run));
      const [original] = await storedDetections();

      const reprocessed = await poll(
        csv(row({ version: '2.0SP', frp: '99.9', confidence: 'h' })),
        AVAILABLE_AT + 86_400_000,
      );
      const result = await store.appendDetections(detectionRecords(reprocessed));

      expect(result.inserted).toBe(0);
      const [stored] = await storedDetections();
      expect(stored?.collection_version).toBe('2.0NRT');
      expect(stored?.frp_mw).toBeCloseTo(12.5, 3);
      expect(stored?.confidence).toBe('nominal');
      expect(stored?.ingested_at.getTime()).toBe(original?.ingested_at.getTime());
    });

    it('accepts a batch that repeats a row inside one statement', async () => {
      // The poller already collapses these, but ON CONFLICT DO NOTHING must not raise a
      // cardinality violation if a caller ever hands over an uncollapsed batch.
      const run = await poll(csv(row()), AVAILABLE_AT);
      const record = onlyRecord(run);

      const result = await store.appendDetections([record, record]);

      expect(result).toEqual({ received: 2, inserted: 1, alreadyPresent: 1 });
    });

    it('writes a reported zero FRP as zero and an unreported one as null', async () => {
      const run = await poll(
        csv(row({ frp: '0.0' }), row({ acq_time: '1130', frp: '' })),
        AVAILABLE_AT,
      );

      await store.appendDetections(detectionRecords(run));

      const values = (await storedDetections()).map((detection) => detection.frp_mw);
      expect(values).toHaveLength(2);
      expect(values).toContain(0);
      expect(values).toContain(null);
    });

    it('writes the breaker verdict with the row, since it can never be applied after', async () => {
      // The runtime role holds SELECT and INSERT on `detections` and nothing else, so
      // `UPDATE ... SET quarantined = true` is not available at any later point. Deciding
      // before the insert is what makes the flag possible at all (TASKS C2).
      const run = await poll(csv(row(), row({ acq_time: '1130' })), AVAILABLE_AT);

      await store.appendDetections(detectionRecords(run, { quarantined: true }));

      expect((await storedDetections()).map((stored) => stored.quarantined)).toEqual([true, true]);
    });

    it('leaves a healthy batch unflagged', async () => {
      const run = await poll(csv(row()), AVAILABLE_AT);

      await store.appendDetections(detectionRecords(run));

      expect((await storedDetections())[0]?.quarantined).toBe(false);
    });

    it('refuses a row with no partition instead of hiding it in a default one', async () => {
      // There is no DEFAULT partition on purpose: a corrupt acq_ts must fail loudly.
      const orphan: DetectionRecord = {
        detectionUid: 'f'.repeat(64),
        source: 'firms:viirs:snpp',
        productTier: 'NRT',
        acqTsIso: '2019-06-01T00:00:00Z',
        availableAt: AVAILABLE_AT,
        lat: '41.85012',
        lon: '26.14003',
        scanKm: null,
        trackKm: null,
        frpMw: null,
        brightnessK: null,
        brightnessBgK: null,
        confidenceRaw: 'n',
        confidence: 'nominal',
        dayNight: null,
        collectionVersion: null,
        sourceRegistryVersion: 'source_registry_v1',
        ingestConfigVersion: 'polling_bbox_v1',
        quarantined: false,
      };

      await expect(store.appendDetections([orphan])).rejects.toThrow(/partition/);
      expect(await storedDetections()).toHaveLength(0);
    });

    it('is a single statement, so a failed batch leaves nothing behind', async () => {
      const good = onlyRecord(await poll(csv(row()), AVAILABLE_AT));
      const bad: DetectionRecord = { ...good, detectionUid: 'NOT-A-SHA256' };

      await expect(store.appendDetections([good, bad])).rejects.toThrow();
      expect(await storedDetections()).toHaveLength(0);
    });
  });

  describe('the append-only grant', () => {
    it('lets the runtime role add to the archive and never rewrite it', async () => {
      // The guarantee is a grant, not a convention (migration 001 §grants). The process
      // that sends alerts must not be able to delete its own evidence.
      const run = await poll(csv(row()), AVAILABLE_AT);
      const records = detectionRecords(run);

      await db.query('SET ROLE fire_watch_app');
      try {
        await expect(store.appendDetections(records)).resolves.toMatchObject({ inserted: 1 });
        await expect(db.query('UPDATE detections SET frp_mw = 0')).rejects.toThrow(
          /permission denied/,
        );
        await expect(db.query('DELETE FROM detections')).rejects.toThrow(/permission denied/);
      } finally {
        await db.query('RESET ROLE');
      }

      expect(await storedDetections()).toHaveLength(1);
    });
  });

  describe('recordPollAttempt', () => {
    async function status(): Promise<Record<string, unknown> | undefined> {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT * FROM source_status WHERE source = 'firms:viirs:snpp'`,
      );
      return rows[0];
    }

    it('creates the row on the first attempt and marks data as seen', async () => {
      const run = await poll(csv(row()), AVAILABLE_AT);

      await store.recordPollAttempt(pollAttempt(run, AVAILABLE_AT));

      expect(await status()).toMatchObject({
        last_attempt_at: new Date(AVAILABLE_AT),
        last_success_at: new Date(AVAILABLE_AT),
        last_data_at: new Date(AVAILABLE_AT),
        consecutive_failures: 0,
        last_error: null,
        outage_frozen: false,
      });
    });

    it('advances the attempt but not the data mark on a healthy empty poll', async () => {
      const withData = await poll(csv(row()), AVAILABLE_AT);
      await store.recordPollAttempt(pollAttempt(withData, AVAILABLE_AT));

      const empty = await poll(csv(), AVAILABLE_AT + 600_000);
      await store.recordPollAttempt(pollAttempt(empty, AVAILABLE_AT + 600_000));

      expect(await status()).toMatchObject({
        last_attempt_at: new Date(AVAILABLE_AT + 600_000),
        last_success_at: new Date(AVAILABLE_AT + 600_000),
        last_data_at: new Date(AVAILABLE_AT),
        consecutive_failures: 0,
      });
    });

    it('counts consecutive failures and keeps the last known success', async () => {
      const ok = await poll(csv(row()), AVAILABLE_AT);
      await store.recordPollAttempt(pollAttempt(ok, AVAILABLE_AT));

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await store.recordPollAttempt({
          source: 'firms:viirs:snpp',
          attemptAt: AVAILABLE_AT + attempt * 600_000,
          succeeded: false,
          receivedRows: 0,
          error: 'ETIMEDOUT after 30s',
        });
      }

      expect(await status()).toMatchObject({
        last_attempt_at: new Date(AVAILABLE_AT + 3 * 600_000),
        last_success_at: new Date(AVAILABLE_AT),
        last_data_at: new Date(AVAILABLE_AT),
        consecutive_failures: 3,
        last_error: 'ETIMEDOUT after 30s',
      });
    });

    it('clears the failure streak and the error on the next success', async () => {
      await store.recordPollAttempt({
        source: 'firms:viirs:snpp',
        attemptAt: AVAILABLE_AT,
        succeeded: false,
        receivedRows: 0,
        error: 'HTTP 503',
      });

      const recovered = await poll(csv(row()), AVAILABLE_AT + 600_000);
      await store.recordPollAttempt(pollAttempt(recovered, AVAILABLE_AT + 600_000));

      expect(await status()).toMatchObject({ consecutive_failures: 0, last_error: null });
    });

    it('leaves the outage freeze to the policy that owns it', async () => {
      await db.query(
        `INSERT INTO source_status (source, outage_frozen) VALUES ('firms:viirs:snpp', true)`,
      );

      const run = await poll(csv(row()), AVAILABLE_AT);
      await store.recordPollAttempt(pollAttempt(run, AVAILABLE_AT));

      // One healthy poll does not end an outage; A2.3 decides that, not the writer.
      expect(await status()).toMatchObject({ outage_frozen: true, consecutive_failures: 0 });
    });

    it('records a failed attempt for a source that has never succeeded', async () => {
      // The row must exist even so: a source that has never answered is a distinct state
      // from a source nobody has ever polled.
      await store.recordPollAttempt({
        source: 'firms:viirs:noaa21',
        attemptAt: AVAILABLE_AT,
        succeeded: false,
        receivedRows: 0,
        error: 'getaddrinfo ENOTFOUND',
      });

      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT * FROM source_status WHERE source = 'firms:viirs:noaa21'`,
      );
      expect(rows[0]).toMatchObject({
        last_success_at: null,
        last_data_at: null,
        consecutive_failures: 1,
      });
    });
  });
});
