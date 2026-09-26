/**
 * The snapshot read path against a real PostGIS: the single-statement active-set read,
 * the transition writer, and — the reason this file exists — ADR-003 A1.4 R1's acceptance
 * test: **every path by which an event leaves the active set changes the ETag.**
 *
 * The removal paths are exercised the way production would take them: a lifecycle
 * transition through the status store, a merge tombstone, and an invalidation. The last
 * two are raw updates on purpose — they are what a future merge job or a manual override
 * would write, and migration 004's trigger has to catch them whether or not the writer
 * remembered `seq`.
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

import type { EventStatusStore } from '../../core/ports/event-status-store.js';
import type { SnapshotReader } from '../../core/ports/snapshot-reader.js';
import { buildSnapshot, snapshotEtag } from '../../core/snapshot/snapshot-builder.js';
import { createPgEventStatusStore, type PgEventStatusWritable } from './pg-event-status-store.js';
import { createPgSnapshotReader, type PgSnapshotReadable } from './pg-snapshot-reader.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The R1 removal test ' +
      'only runs against Postgres, so skipping it in CI is a false green.',
  );
}

const T0 = Date.parse('2026-07-14T10:00:00Z');

describe.skipIf(!hasDocker)('the snapshot read path', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let reader: SnapshotReader;
  let statusStore: EventStatusStore;

  async function insertEvent(
    publicId: string,
    overrides: {
      status?: string;
      displayTier?: string;
      lon?: number;
      lat?: number;
      score?: number;
    } = {},
  ): Promise<void> {
    const status = overrides.status ?? 'active';
    const onMap = status === 'active' || status === 'signal_weakening';
    // The tier a transition would have written: the map while live, the feed once the
    // display window closed, the archive at the end. Schema-checked on insert.
    const displayTier =
      overrides.displayTier ?? (onMap ? 'map' : status === 'archived' ? 'archive' : 'feed');
    await db.query(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid,
         score, detection_count, nearest_place, config_version, source_registry_version,
         display_tier, inactive_since
       ) VALUES ($1, $2, $3, $3, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326),
                 $6, 3, '{"name_bg":"Карлово","name_en":"Karlovo","lat":42.64,"lon":24.8}',
                 'clustering_params_v1', $7, $8, $9)`,
      [
        publicId,
        status,
        new Date(T0),
        overrides.lon ?? 25.1,
        overrides.lat ?? 42.6,
        overrides.score ?? 0.5,
        SOURCE_REGISTRY_VERSION,
        displayTier,
        onMap ? null : new Date(T0),
      ],
    );
  }

  async function etag(): Promise<string> {
    return snapshotEtag((await reader.readActiveSet(0)).maxSeq);
  }

  async function activeIds(): Promise<string[]> {
    return (await reader.readActiveSet(0)).events.map((event) => event.publicId);
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
    // Both ports are the slice of pg they name and nothing wider.
    const readable: PgSnapshotReadable = db;
    const writable: PgEventStatusWritable = db;
    reader = createPgSnapshotReader(readable);
    statusStore = createPgEventStatusStore(writable);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE fire_events, event_detections, detections CASCADE');
  });

  describe('reading the active set', () => {
    it('reports an empty registry as mark 0 and no members', async () => {
      expect(await reader.readActiveSet(0)).toEqual({ maxSeq: 0, events: [] });
    });

    it('returns the map-tier events in seq order with the registry mark', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb', { status: 'no_longer_detected' });
      await insertEvent('fw-2026-ccccc', { status: 'archived' });
      await insertEvent('fw-2026-ddddd', { lon: 23.3, lat: 42.7, score: 0.9 });

      const read = await reader.readActiveSet(0);
      expect(read.events.map((event) => event.publicId)).toEqual([
        'fw-2026-aaaaa',
        'fw-2026-ddddd',
      ]);
      expect(read.events.map((event) => event.seq)).toEqual(
        [...read.events.map((event) => event.seq)].sort((a, b) => a - b),
      );
      // The mark is over the whole registry, so the archived row's seq counts.
      const last = read.events.at(-1);
      expect(read.maxSeq).toBeGreaterThanOrEqual(last?.seq ?? 0);
      expect(read.events[1]).toMatchObject({
        lon: 23.3,
        lat: 42.7,
        score: expect.closeTo(0.9, 5) as number,
        status: 'active',
        detectionCount: 3,
        startedAt: T0,
        lastDetectionAt: T0,
        nearestPlace: { name_bg: 'Карлово', name_en: 'Karlovo', lat: 42.64, lon: 24.8 },
      });
    });

    it('serves a cursor read as only the rows above it, with the mark still global', async () => {
      await insertEvent('fw-2026-aaaaa');
      const { maxSeq: afterFirst } = await reader.readActiveSet(0);
      await insertEvent('fw-2026-bbbbb');
      await insertEvent('fw-2026-ccccc', { status: 'archived' });

      const delta = await reader.readActiveSet(afterFirst);
      expect(delta.events.map((event) => event.publicId)).toEqual(['fw-2026-bbbbb']);
      expect(delta.maxSeq).toBeGreaterThan(delta.events[0]?.seq ?? Number.MAX_SAFE_INTEGER);

      const doc = buildSnapshot({
        read: delta,
        sources: [],
        generatedAtMs: T0,
        afterSeq: afterFirst,
      });
      expect(doc.partial).toBe(true);
      expect(doc.max_seq).toBe(delta.maxSeq);
    });

    it('answers a cursor at the mark with no rows and the same mark (a 304 in waiting)', async () => {
      await insertEvent('fw-2026-aaaaa');
      const { maxSeq } = await reader.readActiveSet(0);
      expect(await reader.readActiveSet(maxSeq)).toEqual({ maxSeq, events: [] });
    });
  });

  describe('R1 — every removal changes the ETag', () => {
    it('when a lifecycle transition takes the event off the map', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      const before = await etag();

      const seq = await statusStore.applyTransition({
        publicId: 'fw-2026-aaaaa',
        status: 'no_longer_detected',
        statusReason: 'miss_evidence',
        displayTier: 'feed',
        inactiveSinceMs: T0 + 3_600_000,
        atMs: T0 + 3_600_000,
      });

      expect(seq).not.toBeNull();
      expect(await activeIds()).toEqual(['fw-2026-bbbbb']);
      const after = await etag();
      expect(after).not.toBe(before);
      expect(after).toBe(snapshotEtag(seq ?? -1));
    });

    it('when a merge tombstones it, even if the writer forgot seq', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      const before = await etag();

      await db.query(
        `UPDATE fire_events SET merged_into = (SELECT id FROM fire_events WHERE public_id = 'fw-2026-bbbbb')
          WHERE public_id = 'fw-2026-aaaaa'`,
      );

      expect(await activeIds()).toEqual(['fw-2026-bbbbb']);
      expect(await etag()).not.toBe(before);
    });

    it('when an operator invalidates it, even if the writer forgot seq', async () => {
      await insertEvent('fw-2026-aaaaa');
      const before = await etag();

      await db.query(
        `UPDATE fire_events SET invalidated = true, invalidated_reason = 'static source'
          WHERE public_id = 'fw-2026-aaaaa'`,
      );

      expect(await activeIds()).toEqual([]);
      const after = await etag();
      expect(after).not.toBe(before);
      // ...and the mark did not fall back to 0 with the set: the client must not
      // mistake "everything is gone" for "nothing ever happened".
      expect((await reader.readActiveSet(0)).maxSeq).toBeGreaterThan(0);
    });

    it('when the display window closes on an event that is already no longer detected', async () => {
      // `no_longer_detected` stays on the map through the display window (D4); the exit
      // is a tier change with no status change, and it must still move the mark.
      await insertEvent('fw-2026-aaaaa', { status: 'no_longer_detected', displayTier: 'map' });
      expect(await activeIds()).toEqual(['fw-2026-aaaaa']);
      const before = await etag();

      await statusStore.applyTransition({
        publicId: 'fw-2026-aaaaa',
        status: 'no_longer_detected',
        statusReason: 'display_window',
        displayTier: 'feed',
        inactiveSinceMs: T0,
        atMs: T0 + 3_600_000,
      });

      expect(await activeIds()).toEqual([]);
      expect(await etag()).not.toBe(before);
    });

    it('when the event comes back, that is a change too', async () => {
      await insertEvent('fw-2026-aaaaa', { status: 'no_longer_detected' });
      const before = await etag();
      expect(await activeIds()).toEqual([]);

      await statusStore.applyTransition({
        publicId: 'fw-2026-aaaaa',
        status: 'active',
        statusReason: 'redetection',
        displayTier: 'map',
        inactiveSinceMs: null,
        atMs: T0 + 3_600_000,
      });

      expect(await activeIds()).toEqual(['fw-2026-aaaaa']);
      expect(await etag()).not.toBe(before);
    });

    it('but a bookkeeping write that changes nothing the client sees leaves it alone', async () => {
      await insertEvent('fw-2026-aaaaa');
      const before = await etag();
      await db.query(
        `UPDATE fire_events SET miss_evidence = miss_evidence + 0.1, updated_at = now()`,
      );
      expect(await etag()).toBe(before);
    });
  });

  describe('the transition writer', () => {
    it('resolves null for a tombstone and for an unknown id, writing nothing', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      await db.query(
        `UPDATE fire_events SET merged_into = (SELECT id FROM fire_events WHERE public_id = 'fw-2026-bbbbb')
          WHERE public_id = 'fw-2026-aaaaa'`,
      );
      const before = await etag();

      const transition = {
        status: 'archived',
        statusReason: 'display_window',
        displayTier: 'archive',
        inactiveSinceMs: T0,
        atMs: T0,
      } as const;
      expect(
        await statusStore.applyTransition({ ...transition, publicId: 'fw-2026-aaaaa' }),
      ).toBeNull();
      expect(
        await statusStore.applyTransition({ ...transition, publicId: 'fw-2026-zzzzz' }),
      ).toBeNull();
      expect(await etag()).toBe(before);
    });

    it('is refused by the schema when the tier contradicts the status', async () => {
      await insertEvent('fw-2026-aaaaa');
      await expect(
        statusStore.applyTransition({
          publicId: 'fw-2026-aaaaa',
          status: 'archived',
          statusReason: 'display_window',
          displayTier: 'map',
          inactiveSinceMs: T0,
          atMs: T0,
        }),
      ).rejects.toThrow(/fire_events_display_tier_matches_status/);
    });
  });

  describe('source observations', () => {
    it('reports the newest acquisition per source and null for a silent one', async () => {
      const uid = (n: number): string => n.toString(16).padStart(64, '0');
      const insertDetection = (n: number, source: string, acqTs: string): Promise<unknown> =>
        db.query(
          `INSERT INTO detections (
             detection_uid, source, product_tier, acq_ts, available_at, lat, lon,
             confidence_raw, confidence, source_registry_version, ingest_config_version
           ) VALUES ($1, $2, 'NRT', $3, $3, 42.6, 25.1, 'n', 'nominal', $4, 'ingest_v1')`,
          [uid(n), source, acqTs, SOURCE_REGISTRY_VERSION],
        );
      await insertDetection(1, 'firms:viirs:snpp', '2026-07-14T09:40:00Z');
      await insertDetection(2, 'firms:viirs:snpp', '2026-07-14T08:10:00Z');
      await insertDetection(3, 'firms:viirs:noaa20', '2026-07-13T23:55:00Z');

      const rows = await reader.readSourceObservations([
        'firms:viirs:noaa20',
        'firms:modis',
        'firms:viirs:snpp',
      ]);
      expect(rows).toEqual([
        { sourceId: 'firms:viirs:noaa20', lastObservedAt: Date.parse('2026-07-13T23:55:00Z') },
        { sourceId: 'firms:modis', lastObservedAt: null },
        { sourceId: 'firms:viirs:snpp', lastObservedAt: Date.parse('2026-07-14T09:40:00Z') },
      ]);
    });
  });
});
