/**
 * Self-serve account export against a real Postgres (TASKS I6; migrations 001–012), run as
 * the runtime role it runs as in production.
 *
 * Proves: every erasure-plan table is read for the account and for nobody else; the sealed
 * centre is opened and never exported as ciphertext; the legacy plaintext `area` arrives as
 * GeoJSON; every column of every covered table is either exported or withheld with a
 * reason (so a future migration cannot add a personal column the export silently skips);
 * the `personal` backup class and the covered tables are the same set; and an erased
 * account exports nothing.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ACCOUNT_EXPORT_TABLES,
  EXPORT_COLUMNS,
  EXPORT_WITHHELD,
} from '../../core/account-export/export-schema.js';
import { createAesGcmZoneCipher } from '../crypto/aes-gcm-zone-cipher.js';
import { createPgAccountEraser } from './pg-account-erasure.js';
import { createPgAccountExporter } from './pg-account-export.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';
const APP_ROLE = 'fire_watch_app';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The account export is ' +
      'only ever executed against Postgres here, so skipping it in CI is a false green.',
  );
}

const AT = Math.floor(Date.now() / 1000) * 1000;
const ISO = new Date(AT - 60_000).toISOString();
const LATER = new Date(AT + 86_400_000).toISOString();

const cipher = createAesGcmZoneCipher({
  active: { id: 'export-test-k1', key: randomBytes(32) },
  retired: [],
});

describe.skipIf(!hasDocker)('account export', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let db: Client;
  let appPool: Pool;
  let eventId: string;

  interface Seeded {
    readonly accountId: string;
    readonly email: string;
    readonly sealedZoneId: string;
    readonly legacyZoneId: string;
  }

  async function seedAccount(): Promise<Seeded> {
    const email = `export-${randomUUID()}@example.org`;
    const { rows: accounts } = await db.query<{ id: string }>(
      `INSERT INTO accounts (timezone, email, email_verified_at, quiet_hours_start)
       VALUES ('Europe/Sofia', $1, $2, '21:30') RETURNING id`,
      [email, ISO],
    );
    const accountId = accounts[0]?.id ?? '';

    const sealedZoneId = randomUUID();
    const sealed = cipher.seal(sealedZoneId, { lat: 42.69751, lon: 23.32415 });
    await db.query(
      `INSERT INTO watch_zones (id, account_id, name, radius_m, min_score, centre_ciphertext,
                                centre_key_id, centre_coarsened, grid_version, grid_cell)
       VALUES ($1, $2, 'Home', 5000, 0.45, $3, $4, true, 'grid5km_v1', '12:34')`,
      [sealedZoneId, accountId, Buffer.from(sealed.ciphertext), sealed.keyId],
    );
    const { rows: legacy } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Legacy', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 3000)
       RETURNING id`,
      [accountId],
    );
    const legacyZoneId = legacy[0]?.id ?? '';

    const { rows: subscriptions } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
       VALUES ($1, 'email', $2) RETURNING id`,
      [accountId, email],
    );
    await db.query(
      `INSERT INTO channel_confirmations (account_id, channel, channel_subscription_id,
                                          token_hash, issued_at, expires_at)
       VALUES ($1, 'email', $2, sha256(convert_to($3, 'UTF8')), $4, $5)`,
      [accountId, subscriptions[0]?.id, `confirm-${accountId}`, ISO, LATER],
    );
    await db.query(
      `INSERT INTO account_sessions (token_hash, account_id, ua_family, created_at,
                                     last_seen_at, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, 'firefox', $3, $3, $4)`,
      [`session-${accountId}`, accountId, ISO, LATER],
    );
    await db.query(
      `INSERT INTO auth_link_requests (email, token_hash, ua_family, requested_at, expires_at)
       VALUES ($1, sha256(convert_to($2, 'UTF8')), 'firefox', $3, $4)`,
      [email, `link-${accountId}`, ISO, LATER],
    );
    await db.query(
      `INSERT INTO alert_states (watch_zone_id, fire_event_id, state) VALUES ($1, $2, 'notified_new')`,
      [sealedZoneId, eventId],
    );
    await db.query(
      `INSERT INTO alert_outbox (watch_zone_id, fire_event_id, alert_type, alert_subkey,
                                 trigger_type, trigger_ref_seq, rule_version, template_id,
                                 template_params, channel, channel_subscription_id, status,
                                 actor_id, decided_at)
       VALUES ($1, $2, 'new_fire', 'once', 'new_fire', 1, 'alert_gating_v1', 'new_fire.bg.v3',
               '{"distanceKm": 4.2}', 'email', $3, 'pending', 'operator-secret', $4)`,
      [sealedZoneId, eventId, subscriptions[0]?.id, ISO],
    );
    return { accountId, email, sealedZoneId, legacyZoneId };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    appPool = new Pool({ connectionString: databaseUrl, max: 2 });
    appPool.on('connect', (client) => {
      void client.query(`SET ROLE ${APP_ROLE}`);
    });
    const { rows: events } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at,
         centroid, score, config_version, source_registry_version
       )
       VALUES ('fw-2026-exprt', 'active', $1, $1, $1,
               ST_SetSRID(ST_MakePoint(23.30, 42.60), 4326), 0.82,
               'clustering_v1', 'source_registry_v1')
       RETURNING id`,
      [ISO],
    );
    eventId = events[0]?.id ?? '';
  }, 300_000);

  afterAll(async () => {
    await appPool?.end();
    await db?.end();
    await container?.stop();
  });

  it('exports every covered table for the account, and nothing of anyone else', async () => {
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const outcome = await createPgAccountExporter(appPool, cipher)(mine.accountId, AT);
    if (outcome.status !== 'exported') throw new Error(outcome.status);
    const { tables } = outcome.document;

    expect(tables.accounts).toHaveLength(1);
    expect(tables.accounts[0]?.['email']).toBe(mine.email);
    expect(tables.accounts[0]?.['quiet_hours_start']).toBe('21:30');
    expect(tables.watch_zones).toHaveLength(2);
    expect(tables.alert_outbox).toHaveLength(1);
    expect(tables.alert_outbox[0]?.['template_params']).toEqual({ distanceKm: 4.2 });
    expect(tables.alert_states).toHaveLength(1);
    expect(tables.channel_subscriptions).toHaveLength(1);
    expect(tables.channel_confirmations).toHaveLength(1);
    expect(tables.account_sessions).toHaveLength(1);
    expect(tables.auth_link_requests).toHaveLength(1);
    expect(tables.alerts_shadow).toEqual([]);
    expect(tables.alert_decision_log).toEqual([]);
    expect(tables.alert_digest_log).toEqual([]);
    expect(tables.erasure_requests).toEqual([]);

    const sealed = tables.watch_zones.find((zone) => zone['id'] === mine.sealedZoneId);
    expect(sealed?.['centre']).toEqual({ lat: 42.69751, lon: 23.32415 });
    expect(sealed?.['centre_status']).toBe('opened');
    expect(sealed?.['min_score']).toBe(0.45);
    const legacy = tables.watch_zones.find((zone) => zone['id'] === mine.legacyZoneId);
    expect(legacy?.['centre_status']).toBe('legacy_plaintext_area');
    expect(legacy?.['area']).toMatchObject({ type: 'Point', coordinates: [23.28, 42.58] });

    const text = JSON.stringify(outcome.document);
    expect(text).not.toContain(theirs.email);
    expect(text).not.toContain(theirs.accountId);
    expect(text).not.toContain('operator-secret');
    expect(text).not.toContain('export-test-k1');
  });

  it('places every column of every covered table on one side: exported or withheld', async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...ACCOUNT_EXPORT_TABLES]],
    );
    const live = rows.map((row) => `${row.table_name}.${row.column_name}`).sort();
    const declared = [
      ...ACCOUNT_EXPORT_TABLES.flatMap((table) =>
        Object.keys(EXPORT_COLUMNS[table]).map((column) => `${table}.${column}`),
      ),
      ...EXPORT_WITHHELD.map((entry) => `${entry.table}.${entry.column}`),
    ].sort();
    expect(declared).toEqual(live);
  });

  it('covers exactly the tables the backup registry classes as personal', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM table_backup_class WHERE class = 'personal' ORDER BY table_name COLLATE "C"`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([...ACCOUNT_EXPORT_TABLES].sort());
  });

  it('an erased account exports nothing; an unknown one is missing', async () => {
    const seeded = await seedAccount();
    await createPgAccountEraser(appPool)(seeded.accountId, AT);
    const exporter = createPgAccountExporter(appPool, cipher);
    expect(await exporter(seeded.accountId, AT)).toEqual({ status: 'erased' });
    expect(await exporter(randomUUID(), AT)).toEqual({ status: 'missing' });
  });
});
