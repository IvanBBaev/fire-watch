/**
 * The per-event detections read path against a real PostGIS, through the route: the merge
 * chain resolves the way ADR-002 I1 says a permalink must, only live membership is public,
 * the body is bounded, and the ETag moves when the event gains a detection.
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
import { eventDetectionsEtag } from '../http/event-detections-route.js';
import { createHealthServer } from '../http/health-server.js';
import {
  createPgEventDetectionsReader,
  type PgEventDetectionsReadable,
} from './pg-event-detections-reader.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The per-event ' +
      'detections read only runs against Postgres, so skipping it in CI is a false green.',
  );
}

const T0 = Date.parse('2026-08-05T03:00:00Z');
const NOW = '2026-08-05T12:00:00Z';
const uid = (n: number): string => n.toString(16).padStart(64, '0');
const url = (id: string): string => `/api/v1/events/${id}/detections`;

interface Body {
  event_id: string;
  merged_into: string | null;
  truncated: boolean;
  features: {
    geometry: { coordinates: [number, number] };
    properties: Record<string, unknown>;
  }[];
}

describe.skipIf(!hasDocker)('the per-event detections read path', () => {
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
      [publicId, new Date(T0), SOURCE_REGISTRY_VERSION],
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

  /** Detection `n`, observed `n` minutes after T0, attached to `eventId` by `runId`. */
  async function attach(
    runId: string,
    eventId: string,
    n: number,
    extra: { frp?: number | null } = {},
  ): Promise<void> {
    const acq = new Date(T0 + n * 60_000);
    await db.query(
      `INSERT INTO detections (
         detection_uid, source, product_tier, acq_ts, available_at, lat, lon, scan_km,
         track_km, frp_mw, confidence_raw, confidence, source_registry_version,
         ingest_config_version
       ) VALUES ($1, 'firms:viirs:noaa21', 'NRT', $2, $2, 41.97712, 27.51634, 0.42, 0.41,
                 $3, 'n', 'nominal', 'sources_v1', 'ingest_v1')
       ON CONFLICT DO NOTHING`,
      [uid(n), acq, extra.frp === undefined ? 9.8 : extra.frp],
    );
    await db.query(
      `INSERT INTO event_detections (clustering_run_id, fire_event_id, detection_uid, acq_ts)
       VALUES ($1, $2, $3, $4)`,
      [runId, eventId, uid(n), acq],
    );
  }

  function server(maxDetections?: number) {
    const readable: PgEventDetectionsReadable = db;
    return createHealthServer({
      reader: { readObservations: () => Promise.reject(new Error('unused')) },
      probe: { ping: () => Promise.reject(new Error('unused')) },
      clock: new VirtualClock(NOW),
      expected: [],
      eventDetections: {
        reader: createPgEventDetectionsReader(readable),
        clock: new VirtualClock(NOW),
        ...(maxDetections === undefined ? {} : { maxDetections }),
      },
    });
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

  it('serves live members oldest first with the stored values, FRP included', async () => {
    const live = await insertRun('live');
    const event = await insertEvent('fw-2026-aaaaa');
    await attach(live, event, 2);
    await attach(live, event, 1, { frp: null });

    const response = await server().inject({ method: 'GET', url: url('fw-2026-aaaaa') });
    expect(response.statusCode).toBe(200);
    const body = response.json<Body>();
    expect(body).toMatchObject({ event_id: 'fw-2026-aaaaa', merged_into: null, truncated: false });
    expect(body.features.map((f) => f.properties)).toEqual([
      {
        uid: uid(1),
        observed_at: '2026-08-05T03:01:00Z',
        source_id: 'firms:viirs:noaa21',
        confidence: 'nominal',
        scan_km: 0.42,
        track_km: 0.41,
      },
      {
        uid: uid(2),
        observed_at: '2026-08-05T03:02:00Z',
        source_id: 'firms:viirs:noaa21',
        confidence: 'nominal',
        scan_km: 0.42,
        track_km: 0.41,
        frp_mw: 9.8,
      },
    ]);
    // The hashed 5-dp decimals survive exactly — no float4/float8 widening on the way.
    expect(body.features[0]?.geometry.coordinates).toEqual([27.51634, 41.97712]);
  });

  it('shows no offline-run membership and counts a detection attached twice once', async () => {
    const live = await insertRun('live');
    const secondLive = await insertRun('live');
    const offline = await insertRun('offline');
    const event = await insertEvent('fw-2026-aaaaa');
    await attach(live, event, 1);
    await attach(secondLive, event, 1);
    await attach(offline, event, 2);

    const body = (await server().inject({ method: 'GET', url: url('fw-2026-aaaaa') })).json<Body>();
    expect(body.features.map((f) => f.properties['uid'])).toEqual([uid(1)]);
  });

  it('bounds the body to the newest members and says so', async () => {
    const live = await insertRun('live');
    const event = await insertEvent('fw-2026-aaaaa');
    for (let n = 1; n <= 5; n += 1) await attach(live, event, n);

    const body = (
      await server(3).inject({ method: 'GET', url: url('fw-2026-aaaaa') })
    ).json<Body>();
    expect(body.truncated).toBe(true);
    expect(body.features.map((f) => f.properties['uid'])).toEqual([uid(3), uid(4), uid(5)]);
  });

  it('resolves a merge chain to its final survivor with a 200, never a 404 (ADR-002 I1)', async () => {
    const live = await insertRun('live');
    const a = await insertEvent('fw-2026-aaaaa');
    const b = await insertEvent('fw-2026-bbbbb');
    const c = await insertEvent('fw-2026-ccccc');
    await attach(live, a, 1);
    await db.query('UPDATE fire_events SET merged_into = $1 WHERE id = $2', [b, a]);
    await db.query('UPDATE fire_events SET merged_into = $1 WHERE id = $2', [c, b]);

    const response = await server().inject({ method: 'GET', url: url('fw-2026-aaaaa') });
    expect(response.statusCode).toBe(200);
    expect(response.json<Body>()).toMatchObject({
      event_id: 'fw-2026-aaaaa',
      merged_into: 'fw-2026-ccccc',
      features: [],
    });
    const seqs = await db.query<{ public_id: string; seq: string }>(
      `SELECT public_id, seq::text AS seq FROM fire_events ORDER BY public_id`,
    );
    const seqOf = (id: string) => Number(seqs.rows.find((r) => r.public_id === id)?.seq);
    expect(response.headers.etag).toBe(
      eventDetectionsEtag(seqOf('fw-2026-aaaaa'), seqOf('fw-2026-ccccc')),
    );
  });

  it('is a 404 only for an id no event ever had', async () => {
    const response = await server().inject({ method: 'GET', url: url('fw-2026-zzzzz') });
    expect(response.statusCode).toBe(404);
  });

  it('changes the ETag when the event gains a detection, and 304s until then', async () => {
    const live = await insertRun('live');
    const event = await insertEvent('fw-2026-aaaaa');
    await attach(live, event, 1);
    const app = server();

    const first = await app.inject({ method: 'GET', url: url('fw-2026-aaaaa') });
    const tag = String(first.headers.etag);
    const again = await app.inject({
      method: 'GET',
      url: url('fw-2026-aaaaa'),
      headers: { 'if-none-match': tag },
    });
    expect(again.statusCode).toBe(304);

    // What the clustering store writes alongside an attachment: the projected count.
    await attach(live, event, 2);
    await db.query(
      'UPDATE fire_events SET detection_count = 2, last_detection_at = $1 WHERE id = $2',
      [new Date(T0 + 2 * 60_000), event],
    );
    const moved = await app.inject({
      method: 'GET',
      url: url('fw-2026-aaaaa'),
      headers: { 'if-none-match': tag },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.headers.etag).not.toBe(tag);
    expect(moved.json<Body>().features).toHaveLength(2);
  });
});
