/**
 * The playback history read (V2-A1) against a real PostGIS, through the route: the window
 * is half-open and aligned, rows come newest first and bounded, only live membership
 * names an event, tombstoned and invalidated events name none, quarantined rows stay, and
 * the stored 5-dp coordinates reach the core undamaged.
 *
 * Skipped without a Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1` turns the skip into a
 * failure so CI cannot go green by not running it.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';

import { VirtualClock } from '../../core/ports/clock.js';
import { createHealthServer } from '../http/health-server.js';
import { createPgHistoryReader, type PgHistoryReadable } from './pg-history-reader.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The playback history ' +
      'read only runs against Postgres, so skipping it in CI is a false green.',
  );
}

/** "Now" is 12:04; the 24h window is [2026-08-04T12:00Z, 2026-08-05T12:00Z). */
const NOW = '2026-08-05T12:04:00Z';
const WINDOW_FROM = Date.parse('2026-08-04T12:00:00Z');
const WINDOW_TO = Date.parse('2026-08-05T12:00:00Z');
const uid = (n: number): string => n.toString(16).padStart(64, '0');

interface Body {
  window_from: string;
  window_to: string;
  truncated: boolean;
  count: number;
  sources: string[];
  events: string[];
  detections: {
    t: number[];
    lon: number[];
    lat: number[];
    frp: (number | null)[];
    s: number[];
    e: number[];
  };
}

describe.skipIf(!hasDocker)('the playback history read path', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  async function insertEvent(publicId: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid,
         score, detection_count, nearest_place, config_version, source_registry_version,
         display_tier, inactive_since
       ) VALUES ($1, 'active', $2, $2, $2, ST_SetSRID(ST_MakePoint(25.1, 42.6), 4326),
                 0.5, 1, NULL, 'clustering_params_v1', $3, 'map', NULL)
       RETURNING id::text AS id`,
      [publicId, new Date(WINDOW_FROM), SOURCE_REGISTRY_VERSION],
    );
    return rows[0]?.id ?? '';
  }

  async function insertRun(kind: 'live' | 'offline'): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO clustering_runs (kind, config_version, config_digest)
       VALUES ($1, 'clustering_v1', 'abcd1234') RETURNING id::text AS id`,
      [kind],
    );
    return rows[0]?.id ?? '';
  }

  /** Detection `n` at `atMs`, optionally attached to `eventId` by `runId`. */
  async function detection(
    n: number,
    atMs: number,
    extra: {
      frp?: number | null;
      quarantined?: boolean;
      attach?: { runId: string; eventId: string };
    } = {},
  ): Promise<void> {
    const acq = new Date(atMs);
    await db.query(
      `INSERT INTO detections (
         detection_uid, source, product_tier, acq_ts, available_at, lat, lon, scan_km,
         track_km, frp_mw, confidence_raw, confidence, source_registry_version,
         ingest_config_version, quarantined
       ) VALUES ($1, 'firms:viirs:noaa21', 'NRT', $2, $2, 41.97712, 27.51651, 0.42, 0.41,
                 $3, 'n', 'nominal', 'sources_v1', 'ingest_v1', $4)`,
      [uid(n), acq, extra.frp === undefined ? 9.84 : extra.frp, extra.quarantined ?? false],
    );
    if (extra.attach !== undefined) {
      await db.query(
        `INSERT INTO event_detections (clustering_run_id, fire_event_id, detection_uid, acq_ts)
         VALUES ($1, $2, $3, $4)`,
        [extra.attach.runId, extra.attach.eventId, uid(n), acq],
      );
    }
  }

  function server(maxDetections?: number) {
    const readable: PgHistoryReadable = db;
    return createHealthServer({
      reader: { readObservations: () => Promise.reject(new Error('unused')) },
      probe: { ping: () => Promise.reject(new Error('unused')) },
      clock: new VirtualClock(NOW),
      expected: [],
      history: {
        reader: createPgHistoryReader(readable),
        clock: new VirtualClock(NOW),
        ...(maxDetections === undefined ? {} : { maxDetections }),
      },
    });
  }

  async function get(maxDetections?: number): Promise<Body> {
    const response = await server(maxDetections).inject({
      method: 'GET',
      url: '/api/v1/history?range=24h',
    });
    expect(response.statusCode).toBe(200);
    return response.json<Body>();
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
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE fire_events, event_detections, detections, clustering_runs CASCADE');
  });

  it('reads the half-open aligned window, oldest first, with quantised stored values', async () => {
    await detection(1, WINDOW_FROM - 60_000);
    await detection(2, WINDOW_FROM);
    await detection(3, WINDOW_FROM + 90 * 60_000, { frp: null });
    await detection(4, WINDOW_TO - 60_000, { quarantined: true });
    await detection(5, WINDOW_TO);
    await detection(6, Date.parse(NOW) - 60_000);

    const body = await get();
    expect(body).toMatchObject({
      window_from: '2026-08-04T12:00:00Z',
      window_to: '2026-08-05T12:00:00Z',
      truncated: false,
      count: 3,
      sources: ['firms:viirs:noaa21'],
      events: [],
      detections: {
        t: [0, 90, 24 * 60 - 1],
        lon: [27.517, 27.517, 27.517],
        lat: [41.977, 41.977, 41.977],
        frp: [9.8, null, 9.8],
        s: [0, 0, 0],
        e: [-1, -1, -1],
      },
    });
  });

  it('names only the live event, never an offline, merged or invalidated one', async () => {
    const live = await insertRun('live');
    const offline = await insertRun('offline');
    const open = await insertEvent('fw-2026-aaaaa');
    const merged = await insertEvent('fw-2026-bbbbb');
    const invalid = await insertEvent('fw-2026-ccccc');
    await db.query('UPDATE fire_events SET merged_into = $1 WHERE id = $2', [open, merged]);
    await db.query(
      `UPDATE fire_events SET invalidated = true, invalidated_reason = 'static_source', score = 0
        WHERE id = $1`,
      [invalid],
    );

    await detection(1, WINDOW_FROM + 60_000, { attach: { runId: live, eventId: open } });
    await detection(2, WINDOW_FROM + 2 * 60_000, { attach: { runId: offline, eventId: open } });
    await detection(3, WINDOW_FROM + 3 * 60_000, { attach: { runId: live, eventId: merged } });
    await detection(4, WINDOW_FROM + 4 * 60_000, { attach: { runId: live, eventId: invalid } });

    const body = await get();
    expect(body.events).toEqual(['fw-2026-aaaaa']);
    expect(body.detections.e).toEqual([0, -1, -1, -1]);
  });

  it('keeps the newest rows past the bound and flags the body truncated', async () => {
    for (let n = 1; n <= 5; n += 1) await detection(n, WINDOW_FROM + n * 60_000);
    const body = await get(3);
    expect(body.truncated).toBe(true);
    expect(body.count).toBe(3);
    expect(body.detections.t).toEqual([3, 4, 5]);
  });

  it('answers an empty window with an empty, well-formed document', async () => {
    const body = await get();
    expect(body).toMatchObject({ count: 0, truncated: false, sources: [], events: [] });
    expect(body.detections.t).toEqual([]);
  });
});
