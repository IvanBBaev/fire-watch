/**
 * The nightly backup and its restore against a real PostGIS (TASKS C6; OPERATIONS §6.2,
 * §6.3): one exported snapshot held by an interactive psql, two pg_dump artifacts from
 * it, both restored into a scratch database — and a main artifact restored alone leaves
 * every personal table empty (rule 8).
 *
 * The Postgres tools run inside the container through `docker exec -i`, as they run
 * through `docker compose exec -T` in production. `age` is replaced by a pass-through
 * script so the test does not need it on the runner; the encryption stage itself is
 * age's to get right, the plumbing around it is ours.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBackup } from '../../core/backup/backup-run.js';
import { runRestore } from '../../core/backup/restore-run.js';
import { systemClock } from '../clock/system-clock.js';
import { NO_BACKUP_PINGER } from './healthchecks-backup-pinger.js';
import { createLocalFsBackupStore } from './local-fs-backup-store.js';
import {
  createFsRestoreWorkspace,
  createPgDumpAgeProducer,
  createPgRestoreTarget,
  createPsqlBackupDatabase,
  type PgConnection,
} from './pg-backup-tools.js';
import { createProcessRunner } from './process-runner.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';

const serverDir = fileURLToPath(new URL('../../../', import.meta.url));
const dbmateBin = fileURLToPath(new URL('../../../node_modules/.bin/dbmate', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The backup and restore ' +
      'are only ever executed against Postgres here, so skipping them in CI is a false green.',
  );
}

describe.skipIf(!hasDocker)('nightly backup and restore', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let work: string;
  let connection: PgConnection;
  let ageStandIn: string;
  const runner = createProcessRunner();
  const lines: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    await pool.query("INSERT INTO accounts (timezone) VALUES ('Europe/Sofia'), ('Europe/Athens')");

    work = mkdtempSync(join(tmpdir(), 'fw-backup-it-'));
    ageStandIn = join(work, 'age');
    writeFileSync(ageStandIn, '#!/bin/sh\nexec cat\n');
    chmodSync(ageStandIn, 0o755);
    connection = {
      execPrefix: ['docker', 'exec', '-i', container.getId()],
      user: container.getUsername(),
      database: container.getDatabase(),
    };
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  });

  function stores() {
    return createLocalFsBackupStore({ root: join(work, 'bucket'), clock: systemClock });
  }

  async function restore(database: string, mainOnly: boolean) {
    const workspace = createFsRestoreWorkspace(join(work, `restore-${database}`));
    await workspace.prepare();
    return runRestore(
      {
        database,
        mainKey: null,
        mainOnly,
        localMigrationFiles: readdirSync(migrationsDir),
      },
      {
        reader: stores(),
        target: createPgRestoreTarget(runner, {
          connection,
          ageIdentityFile: '/dev/null',
          ageCommand: ageStandIn,
        }),
        workspace,
        clock: systemClock,
        writeLine: (line) => lines.push(line),
      },
    );
  }

  it('dumps both sets from one snapshot and uploads them', async () => {
    const summary = await runBackup(
      { dryRun: false, keepLocalMain: 1 },
      {
        database: createPsqlBackupDatabase(runner, connection),
        producer: createPgDumpAgeProducer(runner, {
          connection,
          ageRecipient: 'age1standin',
          stagingDir: join(work, 'staging'),
          ageCommand: ageStandIn,
        }),
        writer: stores(),
        pinger: NO_BACKUP_PINGER,
        clock: systemClock,
        writeLine: (line) => lines.push(line),
      },
    );
    expect(summary.plan.unclassified).toEqual([]);
    expect(summary.uploaded.map((u) => u.set)).toEqual(['main', 'personal']);
    expect(await stores().list('fw-')).toHaveLength(summary.uploaded.flatMap((u) => u.keys).length);
    // Per-table gauges, counted inside the same snapshot (migration 013 classifies the ledger).
    const gauges = summary.tableGauges;
    expect(gauges?.unplanned).toEqual([]);
    expect(gauges?.gauges.find((g) => g.relation === 'schema_migrations')?.set).toBe('main');
    const accounts = gauges?.gauges.find((g) => g.relation === 'accounts');
    expect(accounts?.set).toBe('personal');
    expect(accounts?.rows).toBeGreaterThanOrEqual(2);
    expect(accounts?.bytes).toBeGreaterThan(0);
  }, 120_000);

  it('restores main and its companion: migrations present, personal rows back', async () => {
    const summary = await restore('fw_restore_drill', false);
    expect(summary.findings).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.companion.status).toBe('restored');
    expect(summary.personalRows.personalRows).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('restores main alone with every personal table empty (rule 8)', async () => {
    const summary = await restore('fw_restore_main_only', true);
    expect(summary.companion.status).toBe('skipped');
    expect(summary.personalRows.leaked).toEqual([]);
    expect(summary.ok).toBe(true);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_database WHERE datname IN ('fw_restore_drill', 'fw_restore_main_only')",
    );
    expect(rows[0]?.n).toBe('2');
  }, 120_000);

  it('never restores on top of an existing database', async () => {
    await expect(restore('fw_restore_drill', true)).rejects.toThrow(/already exists/);
  }, 60_000);
});
