/**
 * The freshness read path against a real Postgres (TASKS C5).
 *
 * Three things can only be checked here, and all three are load-bearing for a surface
 * whose whole job is to be right about outages:
 *
 *  1. The reader reads what `recordPollAttempt` writes. They are two modules that touch
 *     `source_status` from opposite sides, and a column renamed in one of them would
 *     otherwise show up as a permanently `unknown` fleet rather than as a failing test.
 *  2. `= ANY($1::text[])` really does take a JS array through the driver, and a source
 *     that has never been polled is simply *absent* rather than a row of nulls.
 *  3. A statement timeout raises SQLSTATE `57014`. `health-server.ts` maps exactly that
 *     code to `freshness_query_timeout`; the constant is worth pinning against the
 *     database rather than against our memory of it.
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

import { createPgDetectionStore } from './pg-detection-store.js';
import {
  createPgDatabaseProbe,
  createPgFreshnessReader,
  type PgReadable,
} from './pg-freshness-reader.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The health endpoint’s ' +
      'read path is only ever executed here, so skipping it in CI is a false green.',
  );
}

const ATTEMPT_AT = Date.parse('2026-08-02T11:29:30Z');

describe.skipIf(!hasDocker)('the freshness read path', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let reader: ReturnType<typeof createPgFreshnessReader>;
  let store: ReturnType<typeof createPgDetectionStore>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;

    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    // A `Client` is a `PgReadable` — the port is the slice of pg this module uses and
    // nothing wider. If that stops type-checking, the reader grew a dependency.
    const readable: PgReadable = db;
    reader = createPgFreshnessReader(readable);
    store = createPgDetectionStore(db);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM source_status');
  });

  it('reads back exactly what a successful poll recorded', async () => {
    await store.recordPollAttempt({
      source: 'firms:viirs:snpp',
      attemptAt: ATTEMPT_AT,
      succeeded: true,
      receivedRows: 37,
      error: null,
    });

    const observations = await reader.readObservations(['firms:viirs:snpp']);

    expect(observations).toEqual([
      {
        row: 'firms:viirs:snpp',
        lastAttemptAt: ATTEMPT_AT,
        lastSuccessAt: ATTEMPT_AT,
        lastDataAt: ATTEMPT_AT,
        consecutiveFailures: 0,
      },
    ]);
  });

  it('keeps the attempt and the success apart when a poll fails', async () => {
    // The distinction the whole verdict rests on: attempted-and-never-succeeded is
    // `critical`, never-attempted is `unknown`, and only these two columns can tell them
    // apart once the process that knew has been restarted.
    await store.recordPollAttempt({
      source: 'firms:viirs:noaa20',
      attemptAt: ATTEMPT_AT,
      succeeded: false,
      receivedRows: 0,
      error: 'HTTP 503 from the Area API',
    });

    const [observation] = await reader.readObservations(['firms:viirs:noaa20']);

    expect(observation).toMatchObject({
      lastAttemptAt: ATTEMPT_AT,
      lastSuccessAt: null,
      lastDataAt: null,
      consecutiveFailures: 1,
    });
  });

  it('does not move last_data_at for a poll that succeeded and found nothing', async () => {
    // A quiet afternoon is not an outage (§1.1(5)). It is still visible, because a feed
    // that has said nothing for nine hours in August is worth seeing.
    await store.recordPollAttempt({
      source: 'firms:viirs:noaa21',
      attemptAt: ATTEMPT_AT,
      succeeded: true,
      receivedRows: 0,
      error: null,
    });

    const [observation] = await reader.readObservations(['firms:viirs:noaa21']);

    expect(observation).toMatchObject({ lastSuccessAt: ATTEMPT_AT, lastDataAt: null });
  });

  it('omits a source that has never been polled rather than inventing a row', async () => {
    await store.recordPollAttempt({
      source: 'firms:viirs:snpp',
      attemptAt: ATTEMPT_AT,
      succeeded: true,
      receivedRows: 1,
      error: null,
    });

    const observations = await reader.readObservations([
      'firms:viirs:snpp',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
    ]);

    expect(observations.map((observation) => observation.row)).toEqual(['firms:viirs:snpp']);
  });

  it('answers for the whole fleet in one round trip', async () => {
    for (const source of [
      'firms:viirs:snpp',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
    ] as const) {
      await store.recordPollAttempt({
        source,
        attemptAt: ATTEMPT_AT,
        succeeded: true,
        receivedRows: 1,
        error: null,
      });
    }

    const observations = await reader.readObservations([
      'firms:viirs:snpp',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
    ]);

    expect(observations).toHaveLength(3);
  });

  it('raises the SQLSTATE the health endpoint reports as a timeout', async () => {
    // `57014` is the literal in `health-server.ts`. If a Postgres upgrade ever changed it,
    // the endpoint would answer `freshness_query_failed` for a timeout and send whoever is
    // paged looking for a dead database instead of for whatever is holding the lock.
    await db.query("SET statement_timeout = '50ms'");
    try {
      const thrown: unknown = await db.query('SELECT pg_sleep(1)').then(
        () => null,
        (error: unknown) => error,
      );
      expect((thrown as { code?: unknown }).code).toBe('57014');
    } finally {
      await db.query('RESET statement_timeout');
    }
  });

  it('answers the readiness question without depending on a migration', async () => {
    await expect(createPgDatabaseProbe(db).ping()).resolves.toBeUndefined();
  });
});
