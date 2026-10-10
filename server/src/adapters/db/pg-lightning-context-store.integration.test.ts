/**
 * The F18 lightning context store against a real PostGIS (migrations 022, 024): pending
 * events, recomputing after the event moves, the archive backfill's list, the upsert and
 * its no-downgrade guard, the constraints that keep "no data" apart from "no lightning", the merge
 * chain on read, and that answering never bumps the event's `seq`.
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

import { LIGHTNING_CONTEXT_DRIFT } from '../../core/config/lightning-context.js';
import type { LightningContextRow } from '../../core/ports/lightning-context-store.js';
import { createPgLightningContextStore } from './pg-lightning-context-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The lightning context ' +
      'store only runs against Postgres, so skipping it in CI is a false green.',
  );
}

const T0 = Date.parse('2026-08-05T03:00:00Z');
const HOUR = 3_600_000;
const DRIFT = LIGHTNING_CONTEXT_DRIFT;

describe.skipIf(!hasDocker)('the lightning context store', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  async function insertEvent(publicId: string, startedAt: number): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid,
         score, detection_count, nearest_place, config_version, source_registry_version,
         display_tier, inactive_since
       ) VALUES ($1, 'active', $2, $2, $2, ST_SetSRID(ST_MakePoint(25.1, 42.6), 4326),
                 0.5, 1, NULL, 'clustering_params_v1', $3, 'map', NULL)
       RETURNING id::text AS id`,
      [publicId, new Date(startedAt), SOURCE_REGISTRY_VERSION],
    );
    return rows[0]?.id ?? '';
  }

  async function seqOf(id: string): Promise<string> {
    const { rows } = await db.query<{ seq: string }>(
      'SELECT seq::text AS seq FROM fire_events WHERE id = $1',
      [id],
    );
    return rows[0]?.seq ?? '';
  }

  function complete(eventId: string, overrides: Partial<LightningContextRow> = {}) {
    return {
      eventId,
      status: 'complete',
      windowFrom: T0 - 3 * HOUR,
      windowTo: T0,
      radiusKm: 10,
      lat: 42.6,
      lon: 25.1,
      flashCount: 4,
      nearestKm: 5.6,
      paramsVersion: 'lightning_context_v1',
      filterVersion: 'lightning_filter_v1',
      computedAt: T0 + HOUR,
      ...overrides,
    } satisfies LightningContextRow;
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
    await db.query('TRUNCATE fire_events CASCADE');
  });

  it('lists live events without an answer, newest first, with the centroid', async () => {
    const older = await insertEvent('fw-2026-aaaaa', T0);
    const newer = await insertEvent('fw-2026-bbbbb', T0 + HOUR);
    const store = createPgLightningContextStore(db);
    const pending = await store.pendingEvents('lightning_context_v1', 10, DRIFT);
    expect(pending.map((p) => p.eventId)).toEqual([newer, older]);
    expect(pending[1]).toEqual({
      eventId: older,
      lat: 42.6,
      lon: 25.1,
      firstDetectedAt: T0,
      previous: null,
    });
    expect(await store.pendingEvents('lightning_context_v1', 1, DRIFT)).toHaveLength(1);
  });

  it('stops listing an answered event until the parameters change, and never bumps seq', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    const seq = await seqOf(id);
    const store = createPgLightningContextStore(db);
    await store.save([complete(id)]);
    expect(await store.pendingEvents('lightning_context_v1', 10, DRIFT)).toEqual([]);
    expect(await store.pendingEvents('lightning_context_v2', 10, DRIFT)).toHaveLength(1);
    await store.save([
      complete(id, {
        status: 'unavailable',
        flashCount: null,
        nearestKm: null,
        paramsVersion: 'lightning_context_v2',
      }),
    ]);
    expect(await store.pendingEvents('lightning_context_v2', 10, DRIFT)).toEqual([]);
    expect(await seqOf(id)).toBe(seq);
  });

  it('lists an answered event again once its centroid or first detection moves', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    const store = createPgLightningContextStore(db);
    await store.save([complete(id)]);
    // ~0.5 km north: inside the tolerance.
    await db.query(
      'UPDATE fire_events SET centroid = ST_SetSRID(ST_MakePoint(25.1, 42.6045), 4326) WHERE id = $1',
      [id],
    );
    expect(await store.pendingEvents('lightning_context_v1', 10, DRIFT)).toEqual([]);
    // ~2.2 km north: beyond it, listed with what the row was computed for.
    await db.query(
      'UPDATE fire_events SET centroid = ST_SetSRID(ST_MakePoint(25.1, 42.62), 4326) WHERE id = $1',
      [id],
    );
    const moved = await store.pendingEvents('lightning_context_v1', 10, DRIFT);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.lat).toBeCloseTo(42.62, 10);
    expect(moved[0]?.previous).toEqual({
      status: 'complete',
      paramsVersion: 'lightning_context_v1',
      windowTo: T0,
      lat: 42.6,
      lon: 25.1,
    });
    // Recomputed for the new point: settled again.
    await store.save([complete(id, { lat: 42.62 })]);
    expect(await store.pendingEvents('lightning_context_v1', 10, DRIFT)).toEqual([]);
    // A merge moved the first detection two minutes earlier: beyond 60 s.
    await db.query('UPDATE fire_events SET started_at = $2 WHERE id = $1', [
      id,
      new Date(T0 - 120_000),
    ]);
    expect(await store.pendingEvents('lightning_context_v1', 10, DRIFT)).toHaveLength(1);
  });

  it('lists incomplete events for the backfill: unavailable, missing, stale; never complete', async () => {
    const unavailable = await insertEvent('fw-2026-aaaaa', T0);
    const missing = await insertEvent('fw-2026-bbbbb', T0 - HOUR);
    const settled = await insertEvent('fw-2026-ccccc', T0 - 2 * HOUR);
    const recent = await insertEvent('fw-2026-ddddd', T0 + 10 * HOUR);
    const store = createPgLightningContextStore(db);
    await store.save([
      complete(unavailable, { status: 'unavailable', flashCount: null, nearestKm: null }),
      complete(settled, { windowTo: T0 - 2 * HOUR, windowFrom: T0 - 5 * HOUR }),
    ]);
    const listed = await store.incompleteEvents('lightning_context_v1', T0 + HOUR, 10, DRIFT);
    expect(listed.map((e) => e.eventId)).toEqual([unavailable, missing]);
    expect(listed[0]?.previous?.status).toBe('unavailable');
    expect(listed.map((e) => e.eventId)).not.toContain(recent);
    expect(await store.incompleteEvents('lightning_context_v1', T0 + HOUR, 1, DRIFT)).toHaveLength(
      1,
    );
  });

  it('never lets an unavailable answer replace a complete one for the same window and point', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    const store = createPgLightningContextStore(db);
    await store.save([complete(id)]);
    const gaveUp = complete(id, {
      status: 'unavailable',
      flashCount: null,
      nearestKm: null,
      computedAt: T0 + 2 * HOUR,
    });
    await store.save([gaveUp]);
    expect(await store.readLightningContext('fw-2026-aaaaa')).toMatchObject({
      row: { status: 'complete', flashCount: 4 },
    });
    // Another point (the event moved): the honest answer for it replaces the old count.
    await store.save([{ ...gaveUp, lat: 42.62 }]);
    expect(await store.readLightningContext('fw-2026-aaaaa')).toMatchObject({
      row: { status: 'unavailable', flashCount: null, lat: 42.62 },
    });
    // And a complete answer always replaces an unavailable one.
    await store.save([complete(id)]);
    expect(await store.readLightningContext('fw-2026-aaaaa')).toMatchObject({
      row: { status: 'complete', lat: 42.6 },
    });
  });

  it('reads the row back, and the survivor row for a merged-away id', async () => {
    const survivor = await insertEvent('fw-2026-aaaaa', T0);
    const merged = await insertEvent('fw-2026-bbbbb', T0 + HOUR);
    await db.query('UPDATE fire_events SET merged_into = $1 WHERE id = $2', [survivor, merged]);
    const store = createPgLightningContextStore(db);
    expect(await store.pendingEvents('lightning_context_v1', 10, DRIFT)).toHaveLength(1);
    expect(await store.readLightningContext('fw-2026-aaaaa')).toEqual({
      kind: 'event',
      firstDetectedAt: T0,
      row: null,
    });
    await store.save([complete(survivor)]);
    expect(await store.readLightningContext('fw-2026-bbbbb')).toEqual({
      kind: 'event',
      firstDetectedAt: T0,
      row: complete(survivor),
    });
    expect(await store.readLightningContext('fw-2026-zzzzz')).toEqual({ kind: 'unknown' });
  });

  it('refuses a count on an unavailable row and a nearest distance with no flashes', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    const store = createPgLightningContextStore(db);
    await expect(store.save([complete(id, { status: 'unavailable' })])).rejects.toThrow(
      /count_iff_complete/,
    );
    await expect(store.save([complete(id, { flashCount: 0 })])).rejects.toThrow(
      /nearest_needs_flashes/,
    );
  });

  it('is deleted with its event', async () => {
    const id = await insertEvent('fw-2026-aaaaa', T0);
    await createPgLightningContextStore(db).save([complete(id)]);
    // The insert trigger logged a transition; that log does not cascade, so clear it first.
    await db.query('DELETE FROM fire_event_transitions WHERE fire_event_id = $1', [id]);
    await db.query('DELETE FROM fire_events WHERE id = $1', [id]);
    const { rows } = await db.query('SELECT 1 FROM event_lightning_context');
    expect(rows).toEqual([]);
  });
});
