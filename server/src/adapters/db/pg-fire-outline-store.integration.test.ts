/**
 * The V2-A4 outline store against a real PostGIS (migration 032): pending events and
 * what makes an event pending again, members read from the live clustering run only,
 * the upsert's geometry round trip and its "no shape, no area" constraint, the pass
 * heartbeat, the active read (version filter, largest first, truncation), and that
 * drawing an outline never bumps the event's `seq`.
 *
 * Synthetic rows only. Skipped without a Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1`
 * turns the skip into a failure so CI cannot go green by not running it.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';

import { FIRE_OUTLINE_PARAMS } from '../../core/config/fire-outline.js';
import { runFireOutlinePass } from '../../core/outlines/fire-outline-pass.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { FireOutlineRow } from '../../core/ports/fire-outline-store.js';
import { createPgFireOutlineStore } from './pg-fire-outline-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The outline store ' +
      'only runs against Postgres, so skipping it in CI is a false green.',
  );
}

const T0 = Date.parse('2026-08-05T03:00:00Z');
const HOUR = 3_600_000;
const V1 = FIRE_OUTLINE_PARAMS.version;
const uid = (n: number): string => n.toString(16).padStart(64, '0');

const SQUARE = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [25.1, 42.6],
        [25.11, 42.6],
        [25.11, 42.61],
        [25.1, 42.61],
        [25.1, 42.6],
      ],
    ],
  ],
} as const;

describe.skipIf(!hasDocker)('the fire outline store', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  async function insertEvent(
    publicId: string,
    lastDetectionAt: number,
    tier: 'map' | 'archive' = 'map',
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid,
         score, detection_count, nearest_place, config_version, source_registry_version,
         display_tier, inactive_since
       ) VALUES ($1, CASE WHEN $4 = 'archive' THEN 'archived' ELSE 'active' END, $2, $2, $2,
                 ST_SetSRID(ST_MakePoint(25.1, 42.6), 4326), 0.5, 1, NULL,
                 'clustering_params_v1', $3, $4,
                 CASE WHEN $4 = 'archive' THEN $2::timestamptz END)
       RETURNING id::text AS id`,
      [publicId, new Date(lastDetectionAt), SOURCE_REGISTRY_VERSION, tier],
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

  async function attach(runId: string, eventId: string, n: number, lon: number): Promise<void> {
    const acq = new Date(T0 + n * 60_000);
    await db.query(
      `INSERT INTO detections (
         detection_uid, source, product_tier, acq_ts, available_at, lat, lon, scan_km,
         track_km, frp_mw, confidence_raw, confidence, source_registry_version,
         ingest_config_version
       ) VALUES ($1, 'firms:viirs:noaa21', 'NRT', $2, $2, 42.6, $3, 0.42, 0.41,
                 9.8, 'n', 'nominal', 'sources_v1', 'ingest_v1')
       ON CONFLICT DO NOTHING`,
      [uid(n), acq, lon],
    );
    await db.query(
      `INSERT INTO event_detections (clustering_run_id, fire_event_id, detection_uid, acq_ts)
       VALUES ($1, $2, $3, $4)`,
      [runId, eventId, uid(n), acq],
    );
  }

  async function seqOf(id: string): Promise<string> {
    const { rows } = await db.query<{ seq: string }>(
      'SELECT seq::text AS seq FROM fire_events WHERE id = $1',
      [id],
    );
    return rows[0]?.seq ?? '';
  }

  function row(eventId: string, overrides: Partial<FireOutlineRow> = {}): FireOutlineRow {
    return {
      eventId,
      paramsVersion: V1,
      detectionCount: 1,
      lastDetectionAt: T0,
      footprints: 1,
      geometry: SQUARE,
      areaHa: 90,
      areaLowHa: 60,
      areaHighHa: 120,
      edgeUncertaintyKm: 0.21,
      computedAt: T0 + HOUR,
      ...overrides,
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
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE fire_events, detections, clustering_runs, fire_outline_pass CASCADE');
  });

  it('lists map events without an outline, newest first, and skips the archive tier', async () => {
    const older = await insertEvent('fw-2026-aaaaa', T0);
    const newer = await insertEvent('fw-2026-bbbbb', T0 + HOUR);
    await insertEvent('fw-2026-ccccc', T0 + 2 * HOUR, 'archive');
    const store = createPgFireOutlineStore(db);
    const pending = await store.pendingEvents(V1, 10);
    expect(pending).toEqual([
      { eventId: newer, detectionCount: 1, lastDetectionAt: T0 + HOUR },
      { eventId: older, detectionCount: 1, lastDetectionAt: T0 },
    ]);
    expect(await store.pendingEvents(V1, 1)).toHaveLength(1);
  });

  it('lists an event again when it gains detections or the parameters change', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    const seq = await seqOf(id);
    const store = createPgFireOutlineStore(db);
    await store.save([row(id)]);
    expect(await store.pendingEvents(V1, 10)).toEqual([]);
    expect(await store.pendingEvents('fire_outline_params_v2', 10)).toHaveLength(1);
    expect(await seqOf(id)).toBe(seq);

    await db.query(
      `UPDATE fire_events SET detection_count = 2, last_detection_at = $2 WHERE id = $1`,
      [id, new Date(T0 + HOUR)],
    );
    expect(await store.pendingEvents(V1, 10)).toEqual([
      { eventId: id, detectionCount: 2, lastDetectionAt: T0 + HOUR },
    ]);
  });

  it('reads members from the live run only, decoded for the outline', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    const live = await insertRun('live');
    const offline = await insertRun('offline');
    await attach(live, id, 1, 25.1);
    await attach(offline, id, 2, 25.2);
    const store = createPgFireOutlineStore(db);
    expect(await store.members(id, 10)).toEqual([
      {
        uid: uid(1),
        sourceId: 'firms:viirs:noaa21',
        lat: 42.6,
        lon: 25.1,
        scanKm: 0.42,
        trackKm: 0.41,
      },
    ]);
  });

  it('round-trips the geometry and keeps an empty answer apart from a shape', async () => {
    const big = await insertEvent('fw-2026-aaaaa', T0);
    const small = await insertEvent('fw-2026-bbbbb', T0);
    const none = await insertEvent('fw-2026-ccccc', T0);
    const store = createPgFireOutlineStore(db);
    await store.save([
      row(big),
      row(small, { areaHa: 10, areaLowHa: 0, areaHighHa: 30 }),
      row(none, {
        geometry: null,
        footprints: 0,
        areaHa: null,
        areaLowHa: null,
        areaHighHa: null,
        edgeUncertaintyKm: null,
      }),
    ]);

    expect(await store.readActiveOutlines(10)).toEqual({
      pass: null,
      outlines: [],
      truncated: false,
    });
    await store.recordPass(V1, T0 + HOUR);

    const read = await store.readActiveOutlines(10);
    expect(read.pass).toEqual({ paramsVersion: V1, completedAt: T0 + HOUR });
    expect(read.truncated).toBe(false);
    expect(read.outlines.map((o) => o.publicId)).toEqual(['fw-2026-aaaaa', 'fw-2026-bbbbb']);
    expect(read.outlines[0]).toEqual({
      publicId: 'fw-2026-aaaaa',
      geometry: SQUARE,
      areaHa: 90,
      areaLowHa: 60,
      areaHighHa: 120,
      edgeUncertaintyKm: 0.21,
      footprints: 1,
      lastDetectionAt: T0,
    });

    const cut = await store.readActiveOutlines(1);
    expect(cut.outlines.map((o) => o.publicId)).toEqual(['fw-2026-aaaaa']);
    expect(cut.truncated).toBe(true);

    // A pass under new parameters hides the outlines drawn under the old ones.
    await store.recordPass('fire_outline_params_v2', T0 + 2 * HOUR);
    expect((await store.readActiveOutlines(10)).outlines).toEqual([]);
  });

  it('refuses an area without a shape and a band that does not contain the area', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    const store = createPgFireOutlineStore(db);
    await expect(store.save([row(id, { geometry: null })])).rejects.toThrow();
    await expect(store.save([row(id, { areaLowHa: 100 })])).rejects.toThrow();
  });

  it('hides merged and invalidated events from the active read', async () => {
    const kept = await insertEvent('fw-2026-aaaaa', T0);
    const gone = await insertEvent('fw-2026-bbbbb', T0);
    const store = createPgFireOutlineStore(db);
    await store.save([row(kept), row(gone)]);
    await store.recordPass(V1, T0 + HOUR);
    await db.query('UPDATE fire_events SET invalidated = true WHERE id = $1', [gone]);
    const read = await store.readActiveOutlines(10);
    expect(read.outlines.map((o) => o.publicId)).toEqual(['fw-2026-aaaaa']);
    expect(await store.pendingEvents(V1, 10)).toEqual([]);
  });

  it('runs a whole pass end to end from detections to a served outline', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    const live = await insertRun('live');
    await attach(live, id, 1, 25.1);
    await attach(live, id, 2, 25.104);
    const store = createPgFireOutlineStore(db);
    const report = await runFireOutlinePass({ store, clock: new VirtualClock(T0 + HOUR) });
    expect(report).toMatchObject({ pending: 1, drawn: 1, empty: 0, backlog: false });
    const read = await store.readActiveOutlines(10);
    expect(read.outlines).toHaveLength(1);
    const outline = read.outlines[0];
    expect(outline?.footprints).toBe(2);
    expect(outline?.geometry.type).toBe('MultiPolygon');
    expect(outline?.areaHa).toBeGreaterThan(0);
    expect(outline?.areaLowHa).toBeLessThanOrEqual(outline?.areaHa ?? -1);
    expect(outline?.areaHighHa).toBeGreaterThanOrEqual(outline?.areaHa ?? Infinity);
    expect(await store.pendingEvents(V1, 10)).toEqual([]);
  });
});
