/**
 * The migrations against a real PostGIS, because every claim this schema makes is a
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

describe.skipIf(!hasDocker)('migrations — schema invariants', () => {
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
      'account_sessions',
      'accounts',
      'alert_decision_log',
      'alert_digest_log',
      'alert_evaluated_events',
      'alert_evaluation_cursor',
      'alert_outbox',
      'alert_states',
      'alerts_shadow',
      'auth_link_requests',
      'channel_confirmations',
      'channel_subscriptions',
      'clustering_batches',
      'clustering_runs',
      'clusters',
      'detections',
      'erasure_requests',
      'event_detections',
      'events_shadow',
      'fire_event_transitions',
      'fire_events',
      'ingest_batches',
      'ingest_quarantine',
      'lifecycle_log_origin',
      'nrt_lag_histograms',
      'qa_weekly_reports',
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

    it('keeps the alert decision log append-only for the runtime role (migration 014)', async () => {
      const { rows } = await db.query<{
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        class: string | null;
      }>(
        `SELECT has_table_privilege('fire_watch_app', 'alert_decision_log', 'INSERT') AS can_insert,
                has_table_privilege('fire_watch_app', 'alert_decision_log', 'UPDATE') AS can_update,
                has_table_privilege('fire_watch_app', 'alert_decision_log', 'DELETE') AS can_delete,
                (SELECT class FROM table_backup_class
                  WHERE table_name = 'alert_decision_log') AS class`,
      );
      // A decision record that could be rewritten would not be evidence; retention goes
      // through purge_alert_decision_log and erasure through the zone cascade.
      expect(rows[0]).toEqual({
        can_insert: true,
        can_update: false,
        can_delete: false,
        class: 'personal',
      });
    });

    it('keeps the alert digest log append-only for the runtime role (migration 018)', async () => {
      const { rows } = await db.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        class: string | null;
      }>(
        `SELECT has_table_privilege('fire_watch_app', 'alert_digest_log', 'SELECT') AS can_select,
                has_table_privilege('fire_watch_app', 'alert_digest_log', 'INSERT') AS can_insert,
                has_table_privilege('fire_watch_app', 'alert_digest_log', 'UPDATE') AS can_update,
                has_table_privilege('fire_watch_app', 'alert_digest_log', 'DELETE') AS can_delete,
                (SELECT class FROM table_backup_class
                  WHERE table_name = 'alert_digest_log') AS class`,
      );
      // The log is evidence and the digest watermark: a rewritten row would re-send a
      // window. The pass reads it (SELECT) to derive the watermark; erasure goes through
      // the zone cascade, and there is no retention purge yet (migration 018 header).
      expect(rows[0]).toEqual({
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
        class: 'personal',
      });
    });

    it('keeps the lifecycle transition log append-only for the runtime role (migration 020)', async () => {
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT has_table_privilege('fire_watch_app', 'fire_event_transitions', 'SELECT') AS can_select,
                has_table_privilege('fire_watch_app', 'fire_event_transitions', 'INSERT') AS can_insert,
                has_table_privilege('fire_watch_app', 'fire_event_transitions', 'UPDATE') AS can_update,
                has_table_privilege('fire_watch_app', 'fire_event_transitions', 'DELETE') AS can_delete,
                has_table_privilege('fire_watch_app', 'lifecycle_log_origin', 'UPDATE') AS origin_update,
                (SELECT class FROM table_backup_class
                  WHERE table_name = 'fire_event_transitions') AS class`,
      );
      // FER grades the E weights with this history; a rewritten transition would rewrite
      // the evidence. The trigger inserts as the writer, so INSERT is granted.
      expect(rows[0]).toEqual({
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
        origin_update: false,
        class: 'main',
      });
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

      // Postgres reports the rejection as "cannot insert a non-DEFAULT value into
      // column" — the word "generated" appears only in the error detail, which
      // node-postgres does not fold into the message.
      await expect(
        db.query(`INSERT INTO detections (geom) VALUES (ST_SetSRID(ST_MakePoint(0, 0), 4326))`),
      ).rejects.toThrow(/non-DEFAULT/);
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
        status_effective_from: string;
        attach_only: boolean;
      }>(
        // The DATE leaves as text: `pg` parses a bare date as local midnight, so a
        // `Date` round-trip shifts it a day on any host east of UTC. COLLATE "C" so the
        // order is the bytewise one the JS sort below uses.
        `SELECT id, queried_product, product_tier, status,
                to_char(status_effective_from, 'YYYY-MM-DD') AS status_effective_from,
                attach_only
           FROM sources ORDER BY id COLLATE "C"`,
      );

      const projected = rows.map((row) => ({
        id: row.id,
        queriedProduct: row.queried_product,
        productTier: row.product_tier,
        status: row.status,
        statusEffectiveFrom: row.status_effective_from,
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
    // Migration 004 ties `display_tier` and `inactive_since` to `status`, so a row is
    // written the way a lifecycle transition would write it, not with the defaults.
    const insertEvent = (status: string): Promise<unknown> =>
      db.query(
        `INSERT INTO fire_events (
           public_id, status, status_changed_at, started_at, last_detection_at,
           centroid, config_version, source_registry_version, display_tier, inactive_since
         ) VALUES ($1, $2, now(), now(), now(),
                   ST_SetSRID(ST_MakePoint(23.3, 42.7), 4326), 'clustering_params_v1', $3,
                   CASE WHEN $2 = 'archived' THEN 'archive' ELSE 'map' END,
                   CASE WHEN $2 IN ('active', 'signal_weakening') THEN NULL ELSE now() END)`,
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

    it('keeps the display tier and the inactivity anchor consistent with the status', async () => {
      // An active event cannot sit in the archive, and an archived one cannot be on the
      // map: the snapshot trusts `display_tier` without re-deriving it (migration 004).
      await expect(
        db.query(
          `UPDATE fire_events SET display_tier = 'archive'
            WHERE status = 'active' AND id = (SELECT min(id) FROM fire_events WHERE status = 'active')`,
        ),
      ).rejects.toThrow(/fire_events_display_tier_matches_status/);
      await expect(
        db.query(
          `UPDATE fire_events SET inactive_since = now()
            WHERE id = (SELECT min(id) FROM fire_events WHERE status = 'active')`,
        ),
      ).rejects.toThrow(/fire_events_inactive_since_matches_status/);
    });
  });

  describe('seq discipline (ADR-003 A1.4 R1, migration 004)', () => {
    const seqOf = async (publicId: string): Promise<string> => {
      const { rows } = await db.query<{ seq: string }>(
        `SELECT seq::text AS seq FROM fire_events WHERE public_id = $1`,
        [publicId],
      );
      return rows[0]?.seq ?? '';
    };
    const anyActive = async (): Promise<string> => {
      const { rows } = await db.query<{ public_id: string }>(
        `SELECT public_id FROM fire_events WHERE status = 'active' ORDER BY id LIMIT 1`,
      );
      return rows[0]?.public_id ?? '';
    };

    it('bumps seq when a writer changes a projected column and forgets seq', async () => {
      const publicId = await anyActive();
      const before = await seqOf(publicId);
      // The removal path a hand-run curation UPDATE takes: no `seq = nextval(...)`.
      await db.query(`UPDATE fire_events SET invalidated = true WHERE public_id = $1`, [publicId]);
      const after = await seqOf(publicId);
      expect(BigInt(after)).toBeGreaterThan(BigInt(before));
      await db.query(`UPDATE fire_events SET invalidated = false WHERE public_id = $1`, [publicId]);
      expect(BigInt(await seqOf(publicId))).toBeGreaterThan(BigInt(after));
    });

    it('leaves seq alone on a bookkeeping-only update', async () => {
      const publicId = await anyActive();
      const before = await seqOf(publicId);
      // The E accumulator is written every tick; a seq bump there would be a cache miss
      // for every client every tick, for nothing the snapshot shows.
      await db.query(
        `UPDATE fire_events SET miss_evidence = miss_evidence + 0.1, updated_at = now()
          WHERE public_id = $1`,
        [publicId],
      );
      expect(await seqOf(publicId)).toBe(before);
    });

    it('refuses a seq that moves backwards', async () => {
      const publicId = await anyActive();
      await expect(
        db.query(`UPDATE fire_events SET seq = seq - 1 WHERE public_id = $1`, [publicId]),
      ).rejects.toThrow(/must not move backwards/);
    });

    it('accepts the explicit nextval a transition writes, without a second bump', async () => {
      const publicId = await anyActive();
      const { rows } = await db.query<{ next: string; seq: string }>(
        `UPDATE fire_events
            SET status = 'no_longer_detected', status_changed_at = now(),
                inactive_since = now(), seq = nextval('fire_events_seq_seq')
          WHERE public_id = $1
          RETURNING seq::text AS seq, currval('fire_events_seq_seq')::text AS next`,
        [publicId],
      );
      expect(rows[0]?.seq).toBe(rows[0]?.next);
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
      // `attname::text` because node-postgres has no parser for name[] and would hand
      // the aggregate back as one unparsed '{…}' string instead of an array.
      const { rows } = await db.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
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
      // Nothing seeds accounts, and an INSERT … SELECT over an empty table inserts
      // zero rows and "succeeds" — the check must be attempted against a real row.
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO accounts DEFAULT VALUES RETURNING id`,
      );
      await expect(
        db.query(
          `INSERT INTO watch_zones (account_id, name, area, radius_m)
           VALUES ($1, 'too small', ST_SetSRID(ST_MakePoint(23.3, 42.7), 4326)::geography, 1500)`,
          [rows[0]?.id],
        ),
      ).rejects.toThrow(/watch_zones_radius_m_check/);
    });

    it('gives the outbox a claim lease and a shipped locale (migration 015)', async () => {
      const { rows: columns } = await db.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'alert_outbox' AND column_name IN ('claimed_at', 'locale')
          ORDER BY column_name`,
      );
      expect(columns).toEqual([
        {
          column_name: 'claimed_at',
          data_type: 'timestamp with time zone',
          is_nullable: 'YES',
          column_default: null,
        },
        {
          column_name: 'locale',
          data_type: 'text',
          is_nullable: 'NO',
          column_default: "'bg'::text",
        },
      ]);

      const { rows: checks } = await db.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'alert_outbox'::regclass
            AND conname IN ('alert_outbox_claim_has_lease', 'alert_outbox_locale_shipped')
          ORDER BY conname`,
      );
      expect(checks.map((row) => row.conname)).toEqual([
        'alert_outbox_claim_has_lease',
        'alert_outbox_locale_shipped',
      ]);
      expect(checks[0]?.definition).toContain('claimed_at IS NOT NULL');
      expect(checks[1]?.definition).toMatch(/'bg'.*'en'/);

      const { rows: indexes } = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'alert_outbox' AND indexname = 'alert_outbox_claim_lease'`,
      );
      expect(indexes[0]?.indexdef).toContain('(claimed_at)');
      expect(indexes[0]?.indexdef).toContain("'claimed'");
    });
  });

  describe('backup classification (OPERATIONS §6.2)', () => {
    it('classifies every table, so a new one cannot ride into the wrong artifact', async () => {
      // COLLATE "C" to match `tableNames()`: relname is of type name, which always
      // sorts bytewise, while a text column follows the database collation — where the
      // underscore carries no primary weight and 'sources' sorts before 'source_status'.
      const classified = await db.query<{ table_name: string }>(
        `SELECT table_name FROM table_backup_class ORDER BY table_name COLLATE "C"`,
      );
      // `tableNames()` leaves out dbmate's `schema_migrations`, which migration 013
      // registers; `spatial_ref_sys` is PostGIS's and stays unregistered (the backup's
      // relation query skips extension tables).
      const expected = [...(await tableNames()), 'schema_migrations'].sort();
      expect(classified.rows.map((row) => row.table_name)).toEqual(expected);
    });

    it("registers dbmate's schema_migrations as main, so a main-only restore keeps its history", async () => {
      const { rows } = await db.query<{ class: string }>(
        `SELECT class FROM table_backup_class WHERE table_name = 'schema_migrations'`,
      );
      expect(rows).toEqual([{ class: 'main' }]);
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
