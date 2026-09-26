/**
 * The restore drill and the erasure drill (TASKS J2, I7) wired as their CLIs wire them,
 * against a real PostGIS: the local rehearsal of docs/drills/README.md ("Local
 * rehearsal") in executable form.
 *
 * One database plays staging. The restore drill takes a backup with the production job,
 * restores it into a scratch database and verifies it; the erasure drill then seeds a
 * synthetic account, erases it through the production eraser, observes every table as
 * `fire_watch_app` and audits the personal artifacts the restore drill just uploaded.
 * A second restore drill after the erasure proves the tombstone and its guards survive
 * a restore, and a `--main-only` leg proves main alone carries no personal row.
 *
 * The store is the local-filesystem stand-in for R2, and the Postgres tools run inside
 * the container through `docker exec -i`, as they run through `docker compose exec -T`
 * in production. `age` is the real binary when the runner has `age` and `age-keygen` on
 * PATH; otherwise a pass-through script stands in, and only the encryption stage itself
 * goes unexercised.
 *
 * Skipped when there is no Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that
 * skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NO_BACKUP_PINGER } from '../adapters/backup/healthchecks-backup-pinger.js';
import { createLocalFsBackupStore } from '../adapters/backup/local-fs-backup-store.js';
import {
  createFsRestoreWorkspace,
  createPgDumpAgeProducer,
  createPgRestoreTarget,
  createPsqlBackupDatabase,
  type PgConnection,
} from '../adapters/backup/pg-backup-tools.js';
import { createProcessRunner } from '../adapters/backup/process-runner.js';
import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgAccountEraser } from '../adapters/db/pg-account-erasure.js';
import { observeErasure, seedDrillAccount } from '../adapters/db/pg-erasure-drill.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { runBackup } from '../core/backup/backup-run.js';
import { SET_PREFIX } from '../core/backup/backup-keys.js';
import { runRestore } from '../core/backup/restore-run.js';
import { type DrillRecord, drillVerdict } from '../core/drills/drill-record.js';
import { runErasureDrill } from '../core/drills/erasure-drill.js';
import { captureRowCounts, runRestoreDrill } from '../core/drills/restore-drill.js';
import { MANUAL_RTO_STEPS } from '../core/drills/rto.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';
const APP_ROLE = 'fire_watch_app';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const dbmateBin = fileURLToPath(new URL('../../node_modules/.bin/dbmate', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../db/migrations', import.meta.url));

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function realAgeAvailable(): boolean {
  try {
    execFileSync('age', ['--version'], { stdio: 'ignore' });
    execFileSync('age-keygen', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();
if (!hasDocker && process.env['FIRE_WATCH_REQUIRE_DOCKER'] === '1') {
  throw new Error(
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The drills are only ' +
      'ever executed against Postgres here, so skipping them in CI is a false green.',
  );
}

/** Every manual RTO step reported, so a clean run is `passed` rather than `incomplete`. */
const MANUAL_MINUTES: Readonly<Record<string, number>> = Object.fromEntries(
  MANUAL_RTO_STEPS.map((step) => [step.id, 5]),
);

function failing(record: DrillRecord): string[] {
  return [
    ...record.findings,
    ...record.checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}: ${c.detail}`),
    ...record.steps.filter((s) => s.status === 'failed').map((s) => `${s.id}: ${s.detail}`),
  ];
}

/**
 * What a staging database holds before the drills: detections in a live partition, two
 * fire events and a shadow event (the erasure drill's alert legs reference them and never
 * invent one), and two live accounts with a zone, a subscription and a session each, so
 * the personal set carries rows that are not the drill's. docs/drills/README.md "Local
 * rehearsal" loads the same rows by hand.
 */
const REPRESENTATIVE_SEED = `
BEGIN;
SELECT fw_ensure_detections_partition('2026-09-01');
INSERT INTO detections (detection_uid, source, product_tier, acq_ts, available_at, lat, lon,
  confidence_raw, confidence, source_registry_version, ingest_config_version)
SELECT encode(sha256(convert_to('drill-det-' || n, 'UTF8')), 'hex'), 'firms:viirs:snpp', 'NRT',
       timestamptz '2026-09-20 11:00Z' + n * interval '1 minute', timestamptz '2026-09-20 12:00Z',
       42.5 + n * 0.001, 23.2 + n * 0.001, 'n', 'nominal', 'source_registry_v1', 'ingest_config_v1'
FROM generate_series(1, 25) AS n;
INSERT INTO fire_events (public_id, status, status_changed_at, started_at, last_detection_at,
  centroid, score, config_version, source_registry_version)
VALUES ('fw-2026-dr1aa', 'active', '2026-09-20 11:30Z', '2026-09-20 11:00Z', '2026-09-20 11:25Z',
        ST_SetSRID(ST_MakePoint(23.21, 42.51), 4326), 0.8, 'clustering_v1', 'source_registry_v1'),
       ('fw-2026-dr1ab', 'active', '2026-09-21 11:30Z', '2026-09-21 11:00Z', '2026-09-21 11:25Z',
        ST_SetSRID(ST_MakePoint(24.1, 42.1), 4326), 0.6, 'clustering_v1', 'source_registry_v1');
INSERT INTO events_shadow (candidate_version, shadow_key, candidate_config_digest, status,
  started_at, last_detection_at, score, detection_uids)
VALUES ('clustering_params_v2', 'drill-shadow-1', 'digest', 'active', '2026-09-20 11:00Z',
        '2026-09-20 11:25Z', 0.7, ARRAY[encode(sha256(convert_to('drill-det-1', 'UTF8')), 'hex')]);
WITH a AS (
  INSERT INTO accounts (timezone, email, email_verified_at)
  VALUES ('Europe/Sofia', 'live-1@example.invalid', now()),
         ('Europe/Athens', 'live-2@example.invalid', now())
  RETURNING id
), z AS (
  INSERT INTO watch_zones (account_id, name, area, radius_m)
  SELECT id, 'Home', ST_GeogFromText('SRID=4326;POINT(23.3 42.7)'), 3000 FROM a RETURNING account_id
), s AS (
  INSERT INTO channel_subscriptions (account_id, channel, endpoint)
  SELECT id, 'push', 'https://example.invalid/push/' || id FROM a RETURNING account_id
)
INSERT INTO account_sessions (token_hash, account_id, ua_family, created_at, last_seen_at, expires_at)
SELECT sha256(convert_to(id::text, 'UTF8')), id, 'firefox', now(), now(), now() + interval '1 day'
FROM a;
COMMIT;
`;

describe.skipIf(!hasDocker)('restore and erasure drills (local rehearsal)', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let admin: Pool;
  let work: string;
  let connection: PgConnection;
  let age: { command: string; recipient: string; identityFile: string };
  const runner = createProcessRunner();
  const lines: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    admin = new Pool({ connectionString: databaseUrl, max: 2 });
    await admin.query(REPRESENTATIVE_SEED);

    work = mkdtempSync(join(tmpdir(), 'fw-drills-it-'));
    if (realAgeAvailable()) {
      const identityFile = join(work, 'age-identity.txt');
      execFileSync('age-keygen', ['-o', identityFile], { stdio: 'ignore' });
      const recipient = /public key: (age1\w+)/i.exec(readFileSync(identityFile, 'utf8'))?.[1];
      if (recipient === undefined) throw new Error('age-keygen wrote no public key');
      age = { command: 'age', recipient, identityFile };
    } else {
      const standIn = join(work, 'age');
      writeFileSync(standIn, '#!/bin/sh\nexec cat\n');
      chmodSync(standIn, 0o755);
      age = { command: standIn, recipient: 'age1standin', identityFile: '/dev/null' };
    }
    connection = {
      execPrefix: ['docker', 'exec', '-i', container.getId()],
      user: container.getUsername(),
      database: container.getDatabase(),
    };
  }, 300_000);

  afterAll(async () => {
    await admin?.end();
    await container?.stop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  });

  function store() {
    return createLocalFsBackupStore({ root: join(work, 'bucket-drill'), clock: systemClock });
  }

  /** What `restore-drill-cli` does after its config is loaded. */
  function restoreDrill(database: string, mainOnly: boolean): Promise<DrillRecord> {
    const writeLine = (line: string): void => {
      lines.push(line);
    };
    const workspace = createFsRestoreWorkspace(join(work, `restore-${database}`));
    return runRestoreDrill(
      {
        environment: 'local-rehearsal',
        target: { database_name: container.getDatabase(), bucket: 'local-drill' },
        database,
        mainOnly,
        requestedKey: null,
        manualMinutes: MANUAL_MINUTES,
        targetOverride: null,
      },
      {
        clock: systemClock,
        backup: () =>
          runBackup(
            { dryRun: false, keepLocalMain: 0 },
            {
              database: createPsqlBackupDatabase(runner, connection),
              producer: createPgDumpAgeProducer(runner, {
                connection,
                ageRecipient: age.recipient,
                stagingDir: join(work, 'staging'),
                ageCommand: age.command,
              }),
              writer: store(),
              pinger: NO_BACKUP_PINGER,
              clock: systemClock,
              writeLine,
            },
          ),
        async restore(mainKey) {
          await workspace.prepare();
          const captured = captureRowCounts(
            createPgRestoreTarget(runner, {
              connection: { ...connection, database: 'postgres' },
              ageIdentityFile: age.identityFile,
              ageCommand: age.command,
            }),
          );
          const summary = await runRestore(
            {
              database,
              mainKey,
              mainOnly,
              localMigrationFiles: readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')),
            },
            { reader: store(), target: captured.target, workspace, clock: systemClock, writeLine },
          );
          return { summary, restoredCounts: captured.counts() };
        },
      },
    );
  }

  let erasedAccountId: string | null = null;

  it('restore drill: backs up, restores into a scratch database and passes', async () => {
    const record = await restoreDrill('fw_restore_drill_before', false);
    expect(failing(record)).toEqual([]);
    expect(record.rto?.status).toBe('met');
    expect(drillVerdict(record)).toBe('passed');
  }, 180_000);

  it('erasure drill: seeds, erases, observes and audits the backups it can list', async () => {
    const pool = createPgPool({
      databaseUrl,
      role: APP_ROLE,
      applicationName: 'fire-watch-erasure-drill-it',
      max: 2,
    });
    try {
      const reader = store();
      const record = await runErasureDrill(
        {
          environment: 'local-rehearsal',
          target: { database_name: 'drill' },
          targetOverride: null,
        },
        {
          clock: systemClock,
          seed: () => seedDrillAccount(pool, { nowMs: systemClock.now() }),
          erase: createPgAccountEraser(pool),
          observe: (seed) => observeErasure(pool, seed),
          listPersonalBackups: () => reader.list(`${SET_PREFIX.personal}/`),
        },
      );
      expect(failing(record)).toEqual([]);
      expect(drillVerdict(record)).toBe('passed');
      // Every leg ran against the real schema, the write probe included.
      expect(record.checks.map((c) => c.id)).toEqual(
        expect.arrayContaining([
          'erased_write_refused',
          'table_alert_outbox',
          'backup_artifacts_expire_by_deadline',
        ]),
      );
      erasedAccountId = record.facts['account_id'] ?? null;
    } finally {
      await pool.end();
    }
  }, 180_000);

  it('a restore after the erasure keeps the tombstone final, as fire_watch_app', async () => {
    expect(erasedAccountId).not.toBeNull();
    const record = await restoreDrill('fw_restore_drill_after', false);
    expect(failing(record)).toEqual([]);

    const restoredUrl = databaseUrl.replace(
      `/${container.getDatabase()}?`,
      '/fw_restore_drill_after?',
    );
    const restored = createPgPool({
      databaseUrl: restoredUrl,
      role: APP_ROLE,
      applicationName: 'fire-watch-drill-it-restored',
      max: 1,
    });
    try {
      const { rows } = await restored.query<{ email: string | null; deleted: boolean }>(
        'SELECT email, deleted_at IS NOT NULL AS deleted FROM accounts WHERE id = $1',
        [erasedAccountId],
      );
      expect(rows).toEqual([{ email: null, deleted: true }]);
      const ledger = await restored.query('SELECT 1 FROM erasure_requests');
      expect(ledger.rowCount).toBeGreaterThanOrEqual(1);
      await expect(
        restored.query('INSERT INTO account_sessions (account_id) VALUES ($1)', [erasedAccountId]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        restored.query("UPDATE accounts SET email = 'x@example.invalid' WHERE id = $1", [
          erasedAccountId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await restored.end();
    }
  }, 180_000);

  it('restore drill --main-only: main alone restores with every personal table empty', async () => {
    const record = await restoreDrill('fw_restore_drill_main_only', true);
    expect(failing(record)).toEqual([]);
    expect(drillVerdict(record)).toBe('passed');
    const { rows } = await admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_database WHERE datname LIKE 'fw_restore_drill_%'",
    );
    expect(rows[0]?.n).toBe('3');
  }, 180_000);
});
