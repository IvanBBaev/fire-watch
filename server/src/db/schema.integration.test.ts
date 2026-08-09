/**
 * Migration 001 against a real PostGIS, because every claim this schema makes is a
 * claim about Postgres behaviour and none of it is checkable by reading the SQL.
 *
 * The suite is skipped when there is no Docker daemon, which is the normal state of a
 * laptop here. Silent skipping in CI would be worse than no test at all, so
 * `FIRE_WATCH_REQUIRE_DOCKER=1` — set in the CI job — turns the skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SOURCE_REGISTRY, SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';
import { detectionUid } from '@fire-watch/contracts/node';

const execFileAsync = promisify(execFile);

// The tag is pinned: PostGIS behaviour is part of the schema's contract, and "whatever
// :latest is today" would make a green run un-reproducible.
const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const dbmateBin = fileURLToPath(new URL('../../node_modules/.bin/dbmate', import.meta.url));

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The migration suite ' +
      'is the only thing that executes this SQL, so skipping it in CI is a false green.',
  );
}

describe.skipIf(!hasDocker)('migration 001 — initial schema', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let db: Client;

  async function dbmate(...args: string[]): Promise<void> {
    // `--no-dump-schema` because the schema dump shells out to pg_dump, which is not on
    // the host — and rewriting the checked-in db/schema.sql is not a test's business.
    await execFileAsync(dbmateBin, ['--no-dump-schema', ...args], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
  }

  async function tableNames(): Promise<string[]> {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND NOT c.relispartition
          AND c.relname NOT IN ('schema_migrations', 'spatial_ref_sys')
        ORDER BY c.relname`,
    );
    return rows.map((row) => row.table_name);
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    // dbmate speaks to a container with no TLS; without this it negotiates and fails.
    databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;

    // up → down → up. The middle leg is the one that matters: a migration whose `down`
    // is wrong is discovered during an incident, at the worst possible moment.
    await dbmate('up');

    db = new Client({ connectionString: databaseUrl });
    await db.connect();

    const afterFirstUp = await tableNames();
    expect(afterFirstUp).toContain('detections');
    expect(afterFirstUp).toContain('fire_events');

    // `dbmate down` rolls back exactly one migration per invocation, so walk back once
    // per applied migration — anything less leaves the earlier migrations' tables behind.
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM schema_migrations',
    );
    const appliedCount = Number(rows[0]?.n ?? '0');
    expect(appliedCount).toBeGreaterThan(0);
    for (let i = 0; i < appliedCount; i += 1) await dbmate('down');
    expect(await tableNames()).toEqual([]);

    await dbmate('up');
    expect(await tableNames()).toEqual(afterFirstUp);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('creates every table the application expects', async () => {
    expect(await tableNames()).toEqual([
      'accounts',
      'alert_outbox',
      'alert_states',
      'channel_subscriptions',
      'clustering_runs',
      'clusters',
      'detections',
      'event_detections',
      'fire_events',
      'source_status',
      'sources',
      'table_backup_class',
      'watch_zones',
    ]);
  });

  describe('append-only archive (ADR-002 D1/A1.1)', () => {
    it('grants the runtime role INSERT but never UPDATE or DELETE on the archive', async () => {
      const { rows } = await db.query<{
        table_name: string;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        `SELECT t AS table_name,
                has_table_privilege('fire_watch_app', t, 'INSERT') AS can_insert,
                has_table_privilege('fire_watch_app', t, 'UPDATE') AS can_update,
                has_table_privilege('fire_watch_app', t, 'DELETE') AS can_delete
           FROM unnest(ARRAY['detections', 'event_detections']) AS t`,
      );

      for (const row of rows) {
        expect(row.can_insert, `${row.table_name} must be writable`).toBe(true);
        expect(row.can_update, `${row.table_name} must not be updatable`).toBe(false);
        expect(row.can_delete, `${row.table_name} must not be deletable`).toBe(false);
      }
    });

    it('never lets the runtime role delete an outbox row', async () => {
      const { rows } = await db.query<{ can_delete: boolean }>(
        `SELECT has_table_privilege('fire_watch_app', 'alert_outbox', 'DELETE') AS can_delete`,
      );
      // ADR-004 A1.3 rewrites an expired row in place; deleting it would destroy the
      // audit trail of a decision that was already acted on.
      expect(rows[0]?.can_delete).toBe(false);
    });

    it('discards a re-polled detection instead of refining it', async () => {
      const uid = detectionUid({
        source: 'firms:viirs:snpp',
        acqTsIso: '2026-08-02T11:24:00Z',
        lat: '42.69751',
        lon: '23.32415',
      });

      const insert = `
        INSERT INTO detections (
          detection_uid, source, product_tier, acq_ts, available_at,
          lat, lon, frp_mw, confidence_raw, confidence,
          source_registry_version, ingest_config_version
        ) VALUES ($1, 'firms:viirs:snpp', 'NRT', '2026-08-02T11:24:00Z', '2026-08-02T11:41:00Z',
                  '42.69751', '23.32415', $2, $3, $4, $5, 'ingest_v1')
        ON CONFLICT (acq_ts, detection_uid) DO NOTHING`;

      await db.query(insert, [uid, 12.5, 'n', 'nominal', SOURCE_REGISTRY_VERSION]);
      await db.query(insert, [uid, 99.9, 'h', 'high', SOURCE_REGISTRY_VERSION]);

      const { rows } = await db.query<{ count: string; frp_mw: number; confidence: string }>(
        `SELECT count(*)::text AS count, min(frp_mw) AS frp_mw, min(confidence) AS confidence
           FROM detections WHERE detection_uid = $1`,
        [uid],
      );
      expect(rows[0]?.count).toBe('1');
      // The refined values from the second poll are deliberately thrown away: a mutable
      // detection would silently rewrite the evidence behind an alert already sent.
      expect(rows[0]?.frp_mw).toBeCloseTo(12.5, 5);
      expect(rows[0]?.confidence).toBe('nominal');
    });

    it('derives geometry from the hashed coordinates rather than accepting one', async () => {
      const { rows } = await db.query<{ lon: number; lat: number; srid: number }>(
        `SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, ST_SRID(geom) AS srid
           FROM detections LIMIT 1`,
      );
      expect(rows[0]?.lat).toBeCloseTo(42.69751, 5);
      expect(rows[0]?.lon).toBeCloseTo(23.32415, 5);
      // Everything is stored in 4326 and cast to geography for metric predicates; 3857
      // exists only in tile and URL space (review 03).
      expect(rows[0]?.srid).toBe(4326);

      await expect(
        db.query(`INSERT INTO detections (geom) VALUES (ST_SetSRID(ST_MakePoint(0, 0), 4326))`),
      ).rejects.toThrow(/generated/i);
    });
  });

  describe('partitioning (ADR-002 D7)', () => {
    it('covers the backfill range and refuses a row outside it', async () => {
      const inRange = async (acqTsIso: string, lon: string): Promise<void> => {
        const uid = detectionUid({
          source: 'firms:viirs:snpp',
          acqTsIso,
          lat: '42.00000',
          lon,
        });
        await db.query(
          `INSERT INTO detections (
             detection_uid, source, product_tier, acq_ts, available_at,
             lat, lon, confidence_raw, confidence,
             source_registry_version, ingest_config_version
           ) VALUES ($1, 'firms:viirs:snpp', 'NRT', $2, $2, '42.00000', $3, 'n', 'nominal', $4, 'ingest_v1')`,
          [uid, acqTsIso, lon, SOURCE_REGISTRY_VERSION],
        );
      };

      // The 2020–2025 FIRMS SP backfill (task B8) has to land somewhere.
      await expect(inRange('2020-01-15T00:00:00Z', '23.00000')).resolves.toBeUndefined();
      await expect(inRange('2027-12-31T23:59:00Z', '23.00001')).resolves.toBeUndefined();

      // No DEFAULT partition, on purpose: a corrupt timestamp must fail loudly rather
      // than be swallowed into a catch-all that also slows every future ATTACH.
      await expect(inRange('2028-01-01T00:00:00Z', '23.00002')).rejects.toThrow(/partition/i);
    });

    it('exposes a helper the month-swap procedure can call', async () => {
      const { rows } = await db.query<{ name: string }>(
        `SELECT fw_ensure_detections_partition(date '2028-03-09') AS name`,
      );
      expect(rows[0]?.name).toBe('detections_2028_03');
      // Idempotent: the maintenance job runs it unconditionally.
      await expect(
        db.query(`SELECT fw_ensure_detections_partition(date '2028-03-20')`),
      ).resolves.toBeDefined();
    });
  });

  describe('source registry projection (GLOSSARY §1a)', () => {
    it('matches packages/contracts row for row', async () => {
      const { rows } = await db.query<{
        id: string;
        queried_product: string;
        product_tier: string | null;
        status: string;
        status_effective_from: Date;
        attach_only: boolean;
      }>(`SELECT * FROM sources ORDER BY id`);

      const asDate = (value: Date): string => value.toISOString().slice(0, 10);
      const projected = rows.map((row) => ({
        id: row.id,
        queriedProduct: row.queried_product,
        productTier: row.product_tier,
        status: row.status,
        statusEffectiveFrom: asDate(row.status_effective_from),
        attachOnly: row.attach_only,
      }));

      // The TypeScript registry is the owner — these strings are permanent hash inputs.
      // The table is a projection of it, and drift is this failure, never a surprise in
      // production.
      expect(projected).toEqual(
        Object.values(SOURCE_REGISTRY)
          .map((entry) => ({ ...entry }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
    });

    it('refuses a detection from an unregistered source', async () => {
      await expect(
        db.query(
          `INSERT INTO detections (
             detection_uid, source, product_tier, acq_ts, available_at,
             lat, lon, confidence_raw, confidence,
             source_registry_version, ingest_config_version
           ) VALUES (repeat('a', 64), 'firms:viirs:noaa25', 'NRT',
                     '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z',
                     '42.00000', '23.00000', 'n', 'nominal', $1, 'ingest_v1')`,
          [SOURCE_REGISTRY_VERSION],
        ),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  describe('lifecycle vocabulary (ADR-002 D6, GLOSSARY §3)', () => {
    const insertEvent = (status: string): Promise<unknown> =>
      db.query(
        `INSERT INTO fire_events (
           public_id, status, status_changed_at, started_at, last_detection_at,
           centroid, config_version, source_registry_version
         ) VALUES ($1, $2, now(), now(), now(),
                   ST_SetSRID(ST_MakePoint(23.3, 42.7), 4326), 'clustering_params_v1', $3)`,
        [`fw-2026-${Math.random().toString(36).slice(2, 7)}`, status, SOURCE_REGISTRY_VERSION],
      );

    it('accepts every state the ADR defines', async () => {
      for (const status of [
        'active',
        'signal_weakening',
        'no_longer_detected',
        'archived',
        'officially_contained',
        'officially_extinguished',
      ]) {
        await expect(insertEvent(status)).resolves.toBeDefined();
      }
    });

    it('rejects "out", which is the word this project does not use', async () => {
      await expect(insertEvent('out')).rejects.toThrow(/check constraint/i);
    });

    it('gives every event a distinct seq without being asked', async () => {
      const { rows } = await db.query<{ distinct_seq: string; total: string }>(
        `SELECT count(DISTINCT seq)::text AS distinct_seq, count(*)::text AS total FROM fire_events`,
      );
      // ADR-003 A1.4 R1: delta consumers upsert iff the incoming seq is newer, so a
      // duplicate seq makes one of the two changes invisible.
      expect(rows[0]?.distinct_seq).toBe(rows[0]?.total);
    });

    it('refuses a merge tombstone that points at itself', async () => {
      await expect(
        db.query(
          `UPDATE fire_events SET merged_into = id WHERE id = (SELECT min(id) FROM fire_events)`,
        ),
      ).rejects.toThrow(/fire_events_merged_into_not_self/);
    });
  });

  describe('ODbL containment (ADR-002 A1.2)', () => {
    it('stores no OSM element identifier anywhere', async () => {
      const { rows } = await db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name ~* 'osm'`,
      );
      // An osm_* column is what turns "we consulted OSM" into "our registry is derived
      // from the OSM database" — the share-alike trigger, not a naming preference.
      expect(rows).toEqual([]);
    });
  });

  describe('alert pipeline (ADR-004)', () => {
    it('enforces one decision per zone, event, type and subkey', async () => {
      const { rows } = await db.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname ORDER BY a.attname) AS columns
           FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
          WHERE c.conrelid = 'alert_outbox'::regclass AND c.contype = 'u'
          GROUP BY c.oid`,
      );
      expect(rows.map((row) => row.columns)).toEqual([
        ['alert_subkey', 'alert_type', 'fire_event_id', 'watch_zone_id'],
      ]);
    });

    it('has no alert type that could ever read as an all-clear', async () => {
      const { rows } = await db.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'alert_outbox'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%alert_type%'`,
      );
      const definition = rows[0]?.definition ?? '';
      expect(definition).toContain('new_fire');
      // ADR-004 D4: a false all-clear is the most harmful message this system could
      // send, so the vocabulary simply does not contain one.
      expect(definition).not.toMatch(/resolved|safe|all_clear|contained/i);
    });

    it('holds the 2 km watch-zone floor in the schema, not in the UI', async () => {
      await expect(
        db.query(
          `INSERT INTO watch_zones (account_id, name, area, radius_m)
           SELECT id, 'too small', ST_SetSRID(ST_MakePoint(23.3, 42.7), 4326)::geography, 1500
             FROM accounts LIMIT 1`,
        ),
      ).rejects.toThrow(/watch_zones_radius_m_check|no rows|violates/i);
    });
  });

  describe('backup classification (OPERATIONS §6.2)', () => {
    it('classifies every table, so a new one cannot ride into the wrong artifact', async () => {
      const classified = await db.query<{ table_name: string }>(
        `SELECT table_name FROM table_backup_class ORDER BY table_name`,
      );
      expect(classified.rows.map((row) => row.table_name)).toEqual(await tableNames());
    });

    it('keeps every foreign key pointing from personal to main, never the reverse', async () => {
      const { rows } = await db.query<{ child: string; parent: string }>(
        `SELECT child.relname AS child, parent.relname AS parent
           FROM pg_constraint c
           JOIN pg_class child ON child.oid = c.conrelid
           JOIN pg_class parent ON parent.oid = c.confrelid
           JOIN table_backup_class cc ON cc.table_name = child.relname
           JOIN table_backup_class pc ON pc.table_name = parent.relname
          WHERE c.contype = 'f' AND cc.class = 'main' AND pc.class = 'personal'`,
      );
      // A restore from a main artifact older than the personal window brings the
      // personal tables back present and empty. That is only referentially clean while
      // no main table references them.
      expect(rows).toEqual([]);
    });
  });
});
