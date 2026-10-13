/**
 * The change read behind the stream pump against a real PostGIS (TASKS E2). The unit test
 * pins the statement's text against a fake driver; this one pins what that text does:
 *
 *   - rows come back in `seq` order, and an update moves a row to the end (004's trigger
 *     bumps `seq` whether or not the writer did);
 *   - the cursor is exclusive — only rows whose `seq` moved past it;
 *   - there is no membership predicate: a row leaving the map (tier change, merge,
 *     invalidation) is a change the pump must see;
 *   - the `merged_into` self-join surfaces the survivor's public id, never the bigint key;
 *   - `LIMIT` is a page: a full page means "read again", and paging from the last row's
 *     `seq` until a page comes back short visits every row exactly once;
 *   - the mark is over the whole registry and taken in the same statement as the page.
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

import type { ChangeReader, ChangeRow } from '../../core/ports/change-reader.js';
import type { SnapshotReader } from '../../core/ports/snapshot-reader.js';
import { createPgChangeReader } from './pg-change-reader.js';
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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The change read only ' +
      'runs against Postgres, so skipping it in CI is a false green.',
  );
}

const T0 = Date.parse('2026-07-14T10:00:00Z');

describe.skipIf(!hasDocker)('the change read', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let reader: ChangeReader;
  let snapshot: SnapshotReader;

  async function insertEvent(
    publicId: string,
    overrides: { status?: string; displayTier?: string; score?: number } = {},
  ): Promise<void> {
    const status = overrides.status ?? 'active';
    const onMap = status === 'active' || status === 'signal_weakening';
    const displayTier =
      overrides.displayTier ?? (onMap ? 'map' : status === 'archived' ? 'archive' : 'feed');
    await db.query(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid,
         score, detection_count, nearest_place, config_version, source_registry_version,
         display_tier, inactive_since, source_mix
       ) VALUES ($1, $2, $3, $3, $3, ST_SetSRID(ST_MakePoint(25.1, 42.6), 4326),
                 $4, 3, '{"name_bg":"Карлово","name_en":"Karlovo","lat":42.64,"lon":24.8}',
                 'clustering_params_v1', $5, $6, $7, '{"firms:viirs:snpp": 3}'::jsonb)`,
      [
        publicId,
        status,
        new Date(T0),
        overrides.score ?? 0.5,
        SOURCE_REGISTRY_VERSION,
        displayTier,
        onMap ? null : new Date(T0),
      ],
    );
  }

  async function mergeInto(loser: string, survivor: string): Promise<void> {
    // A raw write, as a merge job would issue it: the trigger has to bump `seq`.
    await db.query(
      `UPDATE fire_events
          SET merged_into = (SELECT id FROM fire_events WHERE public_id = $2)
        WHERE public_id = $1`,
      [loser, survivor],
    );
  }

  async function markNow(): Promise<number> {
    return (await reader.readChangesSince(0, 1)).maxSeq;
  }

  function ids(rows: readonly ChangeRow[]): string[] {
    return rows.map((row) => row.publicId);
  }

  function expectStrictlyAscending(rows: readonly ChangeRow[]): void {
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.seq).toBeGreaterThan(rows[i - 1]?.seq ?? Number.MAX_SAFE_INTEGER);
    }
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
    const readable: PgSnapshotReadable = db;
    reader = createPgChangeReader(readable);
    snapshot = createPgSnapshotReader(readable);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE fire_events, event_detections, detections CASCADE');
  });

  describe('the mark', () => {
    it('reads an empty registry as mark 0 and no rows (the no-change marker)', async () => {
      expect(await reader.readChangesSince(0, 10)).toEqual({ maxSeq: 0, rows: [] });
    });

    it('answers a cursor at the mark with no rows and the same mark', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      const maxSeq = await markNow();
      expect(maxSeq).toBeGreaterThan(0);
      expect(await reader.readChangesSince(maxSeq, 10)).toEqual({ maxSeq, rows: [] });
    });

    it('is the same mark the snapshot reports, so a freshness frame names a snapshot', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb', { status: 'archived' });
      await mergeInto('fw-2026-aaaaa', 'fw-2026-bbbbb');
      const changes = await reader.readChangesSince(0, 100);
      expect(changes.maxSeq).toBe((await snapshot.readActiveSet(0)).maxSeq);
      expect(changes.maxSeq).toBe(changes.rows.at(-1)?.seq);
    });
  });

  describe('seq ordering', () => {
    it('returns inserts in seq order with every projected column decoded', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb', { score: 0.9 });
      await insertEvent('fw-2026-ccccc', { status: 'archived' });

      const read = await reader.readChangesSince(0, 100);
      expect(ids(read.rows)).toEqual(['fw-2026-aaaaa', 'fw-2026-bbbbb', 'fw-2026-ccccc']);
      expectStrictlyAscending(read.rows);
      expect(read.rows[1]).toEqual({
        publicId: 'fw-2026-bbbbb',
        seq: expect.any(Number) as number,
        status: 'active',
        score: expect.closeTo(0.9, 5) as number,
        lon: expect.closeTo(25.1, 6) as number,
        lat: expect.closeTo(42.6, 6) as number,
        startedAt: T0,
        lastDetectionAt: T0,
        detectionCount: 3,
        nearestPlace: { name_bg: 'Карлово', name_en: 'Karlovo', lat: 42.64, lon: 24.8 },
        sourceIds: ['firms:viirs:snpp'],
        staticSourceVerdict: null,
        mergedInto: null,
        displayTier: 'map',
        invalidated: false,
      });
      expect(read.rows[2]).toMatchObject({ status: 'archived', displayTier: 'archive' });
    });

    it('moves an updated row behind every row written before the update', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      await insertEvent('fw-2026-ccccc');
      const before = (await reader.readChangesSince(0, 100)).rows;

      await db.query(`UPDATE fire_events SET score = 0.8 WHERE public_id = 'fw-2026-aaaaa'`);

      const after = await reader.readChangesSince(0, 100);
      expect(ids(after.rows)).toEqual(['fw-2026-bbbbb', 'fw-2026-ccccc', 'fw-2026-aaaaa']);
      expectStrictlyAscending(after.rows);
      // One row per event: the change read is the latest state, not a history.
      expect(after.rows).toHaveLength(3);
      expect(after.rows[2]?.seq).toBeGreaterThan(before.at(-1)?.seq ?? Number.MAX_SAFE_INTEGER);
      expect(after.maxSeq).toBe(after.rows[2]?.seq);
    });

    it('leaves the order alone for a bookkeeping write that changes nothing projected', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      const mark = await markNow();
      await db.query(
        `UPDATE fire_events SET miss_evidence = miss_evidence + 0.1, updated_at = now()`,
      );
      expect(await reader.readChangesSince(mark, 100)).toEqual({ maxSeq: mark, rows: [] });
    });
  });

  describe('the cursor', () => {
    it('returns only the rows whose seq moved past it, exclusive of the cursor itself', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      const cursor = await markNow();
      await insertEvent('fw-2026-ccccc');
      await db.query(`UPDATE fire_events SET score = 0.7 WHERE public_id = 'fw-2026-aaaaa'`);

      const delta = await reader.readChangesSince(cursor, 100);
      expect(ids(delta.rows)).toEqual(['fw-2026-ccccc', 'fw-2026-aaaaa']);
      expect(delta.rows.every((row) => row.seq > cursor)).toBe(true);
      expect(delta.rows[1]?.score).toBeCloseTo(0.7, 5);

      // A cursor one below a row's seq includes that row; at its seq, excludes it.
      const ccc = delta.rows[0]?.seq ?? 0;
      expect(ids((await reader.readChangesSince(ccc - 1, 100)).rows)[0]).toBe('fw-2026-ccccc');
      expect(ids((await reader.readChangesSince(ccc, 100)).rows)).toEqual(['fw-2026-aaaaa']);
    });
  });

  describe('rows leaving the map', () => {
    it('reports a tier change off the map, an invalidation and a merge as changes', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      await insertEvent('fw-2026-ccccc');
      await insertEvent('fw-2026-ddddd');
      const cursor = await markNow();

      await db.query(
        `UPDATE fire_events
            SET status = 'no_longer_detected', display_tier = 'feed', inactive_since = $1
          WHERE public_id = 'fw-2026-aaaaa'`,
        [new Date(T0)],
      );
      await db.query(
        `UPDATE fire_events SET invalidated = true, invalidated_reason = 'static source'
          WHERE public_id = 'fw-2026-bbbbb'`,
      );
      await mergeInto('fw-2026-ccccc', 'fw-2026-ddddd');

      const delta = await reader.readChangesSince(cursor, 100);
      expect(
        delta.rows.map((row) => [row.publicId, row.displayTier, row.invalidated, row.mergedInto]),
      ).toEqual([
        ['fw-2026-aaaaa', 'feed', false, null],
        ['fw-2026-bbbbb', 'map', true, null],
        ['fw-2026-ccccc', 'map', false, 'fw-2026-ddddd'],
      ]);
      // ...and none of them is in the active set any more.
      expect((await snapshot.readActiveSet(0)).events.map((event) => event.publicId)).toEqual([
        'fw-2026-ddddd',
      ]);
    });
  });

  describe('the merged_into self-join', () => {
    it('surfaces the survivor’s public id, not the bigint key', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      await mergeInto('fw-2026-aaaaa', 'fw-2026-bbbbb');

      const read = await reader.readChangesSince(0, 100);
      const loser = read.rows.find((row) => row.publicId === 'fw-2026-aaaaa');
      const survivor = read.rows.find((row) => row.publicId === 'fw-2026-bbbbb');
      expect(loser?.mergedInto).toBe('fw-2026-bbbbb');
      expect(survivor?.mergedInto).toBeNull();
      // The join neither drops the unmerged row nor duplicates the survivor.
      expect(ids(read.rows)).toEqual(['fw-2026-bbbbb', 'fw-2026-aaaaa']);
    });

    it('resolves several losers into one survivor, one row each', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      await insertEvent('fw-2026-ccccc');
      const cursor = await markNow();
      await mergeInto('fw-2026-aaaaa', 'fw-2026-ccccc');
      await mergeInto('fw-2026-bbbbb', 'fw-2026-ccccc');

      const delta = await reader.readChangesSince(cursor, 100);
      expect(delta.rows.map((row) => [row.publicId, row.mergedInto])).toEqual([
        ['fw-2026-aaaaa', 'fw-2026-ccccc'],
        ['fw-2026-bbbbb', 'fw-2026-ccccc'],
      ]);
    });

    it('is one hop: a survivor merged later does not re-emit or re-point its losers', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      await insertEvent('fw-2026-ccccc');
      await mergeInto('fw-2026-aaaaa', 'fw-2026-bbbbb');
      const cursor = await markNow();
      await mergeInto('fw-2026-bbbbb', 'fw-2026-ccccc');

      // Only the row that changed moves; the first loser's tombstone already went out.
      const delta = await reader.readChangesSince(cursor, 100);
      expect(delta.rows.map((row) => [row.publicId, row.mergedInto])).toEqual([
        ['fw-2026-bbbbb', 'fw-2026-ccccc'],
      ]);
      // A full read still names the direct survivor for the first loser.
      const full = await reader.readChangesSince(0, 100);
      expect(full.rows.find((row) => row.publicId === 'fw-2026-aaaaa')?.mergedInto).toBe(
        'fw-2026-bbbbb',
      );
    });
  });

  describe('paging', () => {
    it('caps a page at the limit and keeps the mark global', async () => {
      for (const suffix of ['aaaaa', 'bbbbb', 'ccccc', 'ddddd', 'eeeee']) {
        await insertEvent(`fw-2026-${suffix}`);
      }
      const page = await reader.readChangesSince(0, 2);
      expect(ids(page.rows)).toEqual(['fw-2026-aaaaa', 'fw-2026-bbbbb']);
      expect(page.maxSeq).toBeGreaterThan(page.rows[1]?.seq ?? Number.MAX_SAFE_INTEGER);
    });

    it('visits every row exactly once when the pump pages until a short page', async () => {
      const all = ['aaaaa', 'bbbbb', 'ccccc', 'ddddd', 'eeeee', 'fffff', 'ggggg'].map(
        (suffix) => `fw-2026-${suffix}`,
      );
      for (const id of all) await insertEvent(id);
      // A merge and an update in the middle, so the seq space has holes to step over.
      await mergeInto('fw-2026-bbbbb', 'fw-2026-ccccc');
      await db.query(`UPDATE fire_events SET score = 0.6 WHERE public_id = 'fw-2026-ddddd'`);

      const seen: ChangeRow[] = [];
      let cursor = 0;
      let pages = 0;
      for (;;) {
        const page = await reader.readChangesSince(cursor, 3);
        pages += 1;
        seen.push(...page.rows);
        const last = page.rows.at(-1);
        if (last !== undefined) cursor = last.seq;
        if (page.rows.length < 3) break;
      }
      expect(pages).toBe(3);
      expect([...ids(seen)].sort()).toEqual(all);
      expect(new Set(ids(seen)).size).toBe(all.length);
      expectStrictlyAscending(seen);
      expect(cursor).toBe(await markNow());
      expect(seen.find((row) => row.publicId === 'fw-2026-bbbbb')?.mergedInto).toBe(
        'fw-2026-ccccc',
      );
    });

    it('returns a full page and then an empty one when the rows divide evenly', async () => {
      await insertEvent('fw-2026-aaaaa');
      await insertEvent('fw-2026-bbbbb');
      const first = await reader.readChangesSince(0, 2);
      expect(first.rows).toHaveLength(2);
      const second = await reader.readChangesSince(first.rows[1]?.seq ?? 0, 2);
      expect(second).toEqual({ maxSeq: first.maxSeq, rows: [] });
    });
  });
});
