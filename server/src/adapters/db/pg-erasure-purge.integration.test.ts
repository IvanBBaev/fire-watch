/**
 * The retention purge executor against a real Postgres, run as `fire_watch_app`: the
 * SECURITY DEFINER path for the alert decision log (migration 014), which until now was
 * executed nowhere. The digest log's function (019) is covered next to the digest store,
 * where its watermark is read (`pg-alert-digest-store.integration.test.ts`).
 *
 * Skipped when there is no Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that
 * skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ZONE_GRID, indexCellKey } from '../../core/zones/zone-geometry.js';
import { createAesGcmZoneCipher } from '../crypto/aes-gcm-zone-cipher.js';
import { createPgErasurePurge } from './pg-erasure-purge.js';
import { createPgWatchZoneStore } from './pg-watch-zone-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The purge functions ' +
      'are only ever executed here, so skipping them in CI is a false green.',
  );
}

const CENTRE = { lat: 42.6, lon: 23.3 };
const cipher = createAesGcmZoneCipher({
  active: { id: 'test-key', key: new Uint8Array(32).fill(7) },
  retired: [],
});

describe.skipIf(!hasDocker)('the retention purge executor', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let zoneId = '';
  let eventId = '';
  let seq = 0;

  async function decision(decidedAt: string): Promise<void> {
    seq += 1;
    await db.query(
      `INSERT INTO alert_decision_log (
         watch_zone_id, fire_event_id, trigger_ref_seq, pass, outcome, reason, code,
         alert_type, ladder_step, in_quiet_hours, rule_version, decided_at
       ) VALUES ($1, $2, $3, 'evaluation', 'suppress', 'below_zone_threshold',
                 'suppressed_below_zone_threshold', NULL, 0, false, 'alert_gating_v1', $4)`,
      [zoneId, eventId, seq, decidedAt],
    );
  }

  async function remaining(): Promise<string[]> {
    const { rows } = await db.query<{ day: string }>(
      `SELECT to_char(decided_at AT TIME ZONE 'UTC', 'MM-DD') AS day
       FROM alert_decision_log ORDER BY decided_at`,
    );
    return rows.map((r) => r.day);
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
    // The executor runs with the runtime role's grants, not the container superuser's.
    pool = new Pool({ connectionString: databaseUrl, max: 1, options: '-c role=fire_watch_app' });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE alert_decision_log, watch_zones, accounts, fire_events CASCADE');
    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    zoneId = randomUUID();
    await createPgWatchZoneStore(db).insert({
      id: zoneId,
      accountId: accounts[0]?.id ?? '',
      name: 'Vitosha',
      radiusM: 10_000,
      minScore: 0.45,
      sealed: cipher.seal(zoneId, CENTRE),
      coarsened: false,
      gridVersion: ZONE_GRID.version,
      gridCell: indexCellKey(CENTRE, ZONE_GRID.values),
      createdAtIso: '2026-08-01T00:00:00.000Z',
    });
    const { rows: events } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid,
         config_version, source_registry_version
       ) VALUES ('fw-2026-aaaaa', 'active', now(), now(), now(),
                 ST_SetSRID(ST_MakePoint(23.3, 42.6), 4326), 'clustering_v1', 'source_registry_v1')
       RETURNING id::text AS id`,
    );
    eventId = events[0]?.id ?? '';
  });

  it('runs every connection as the runtime role, which cannot DELETE the log itself', async () => {
    const { rows } = await pool.query<{ role: string }>('SELECT current_user AS role');
    expect(rows).toEqual([{ role: 'fire_watch_app' }]);
    await expect(pool.query('DELETE FROM alert_decision_log')).rejects.toThrow(/permission denied/);
  });

  it('purges decisions before the cutoff, oldest first, up to the cap', async () => {
    for (const day of ['10', '11', '12', '13']) await decision(`2026-08-${day}T12:00:00Z`);
    const purge = createPgErasurePurge(pool);

    expect(await purge.purge('alert_decision_log', '2026-08-13T00:00:00Z', 2)).toBe(2);
    expect(await remaining()).toEqual(['08-12', '08-13']);
    expect(await purge.purge('alert_decision_log', '2026-08-13T00:00:00Z', 10)).toBe(1);
    expect(await remaining()).toEqual(['08-13']);
  });

  it('refuses a cutoff in the future and a non-positive cap', async () => {
    await decision('2026-08-10T12:00:00Z');
    const future = new Date(Date.now() + 86_400_000).toISOString();

    await expect(
      pool.query('SELECT purge_alert_decision_log($1::timestamptz, 10)', [future]),
    ).rejects.toThrow(/cutoff in the past/);
    await expect(
      pool.query("SELECT purge_alert_decision_log('2026-08-11T00:00:00Z'::timestamptz, 0)"),
    ).rejects.toThrow(/max_rows must be positive/);
    expect(await remaining()).toEqual(['08-10']);
  });
});
