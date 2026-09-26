/**
 * Zone deletion against a real Postgres, run as `fire_watch_app` (ADR-004 A1.9): the
 * soft-delete and the cancellation of the zone's queued alerts commit together, only the
 * cancellable statuses move, nothing of another zone or account moves, and a digest pass
 * holding the account `FOR SHARE` is waited out.
 *
 * Skipped when there is no Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that
 * skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OutboxRowDraft } from '../../core/ports/alert-outbox-store.js';
import { createPgAlertOutboxStore } from './pg-alert-outbox-store.js';
import { createPgZoneDeleter } from './pg-zone-deletion.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The zone deletion SQL ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const DECIDED_AT = Date.parse('2026-08-14T12:00:00Z');
const AT = '2026-08-14T13:00:00Z';

describe.skipIf(!hasDocker)('the zone deleter', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl = '';
  let db: Client;
  let pool: Pool;
  let eventId = '';

  interface Seeded {
    readonly accountId: string;
    readonly subscriptionId: string;
    readonly zoneIds: string[];
  }

  async function seed(zoneCount: number): Promise<Seeded> {
    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    const accountId = accounts[0]?.id ?? '';
    const { rows: subscriptions } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
       VALUES ($1, 'push', 'https://example.invalid/push/not-a-real-endpoint') RETURNING id`,
      [accountId],
    );
    const { rows: zones } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       SELECT $1, 'Zone ' || n, ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000
       FROM generate_series(1, $2::integer) AS n
       RETURNING id`,
      [accountId, zoneCount],
    );
    return {
      accountId,
      subscriptionId: subscriptions[0]?.id ?? '',
      zoneIds: zones.map((z) => z.id),
    };
  }

  /** One `pending` row per subkey, then moved to `status` as the superuser. */
  async function row(seeded: Seeded, zoneIndex: number, subkey: string, status: string) {
    const draft: OutboxRowDraft = {
      watchZoneId: seeded.zoneIds[zoneIndex] ?? '',
      fireEventId: eventId,
      alertType: 'escalation',
      alertSubkey: subkey,
      triggerType: 'escalation',
      triggerRefSeq: '1',
      ruleVersion: 'alert_gating_v1',
      templateId: 'escalation.bg.v1',
      templateParams: {},
      channel: 'push',
      channelSubscriptionId: seeded.subscriptionId,
      priority: 20,
      budgetSeq: null,
      status: 'pending',
      actorId: null,
      approverId: null,
      approvalMode: null,
      approvedAt: null,
      budgetOverride: false,
      decidedAt: DECIDED_AT,
      locale: 'bg',
    };
    await createPgAlertOutboxStore(db).enqueue([draft]);
    if (status === 'pending') return;
    await db.query(
      `UPDATE alert_outbox
       SET status = $2,
           claimed_at = CASE WHEN $2 IN ('claimed', 'sent') THEN now() END,
           dispatched_at = CASE WHEN $2 = 'sent' THEN now() END,
           provider_ack_at = CASE WHEN $2 = 'sent' THEN now() END
       WHERE watch_zone_id = $1 AND alert_subkey = $3`,
      [seeded.zoneIds[zoneIndex], status, subkey],
    );
  }

  async function statuses(): Promise<Record<string, string>> {
    const { rows } = await db.query<{ zone: string; subkey: string; status: string }>(
      `SELECT watch_zone_id::text AS zone, alert_subkey AS subkey, status FROM alert_outbox`,
    );
    return Object.fromEntries(rows.map((r) => [`${r.zone}/${r.subkey}`, r.status]));
  }

  async function deletedAt(zoneId: string): Promise<unknown> {
    const { rows } = await db.query<{ deleted_at: unknown }>(
      'SELECT deleted_at FROM watch_zones WHERE id = $1',
      [zoneId],
    );
    return rows[0]?.deleted_at ?? null;
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
    // The deleter runs with the runtime role's grants, not the container superuser's.
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: '-c role=fire_watch_app' });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE alert_outbox, watch_zones, channel_subscriptions, accounts, fire_events CASCADE`,
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid,
         config_version, source_registry_version
       ) VALUES ('fw-2026-aaaaa', 'active', now(), now(), now(),
                 ST_SetSRID(ST_MakePoint(23.3, 42.6), 4326), 'clustering_v1', 'source_registry_v1')
       RETURNING id::text AS id`,
    );
    eventId = rows[0]?.id ?? '';
  });

  it('deletes the zone and cancels its queued alerts, and nothing else', async () => {
    const mine = await seed(2);
    const other = await seed(1);
    const [zone = '', sibling = ''] = mine.zoneIds;
    const [foreign = ''] = other.zoneIds;
    for (const [subkey, status] of [
      ['1', 'pending'],
      ['2', 'awaiting_approval'],
      ['3', 'claimed'],
      ['4', 'sent'],
    ] as const) {
      await row(mine, 0, subkey, status);
    }
    await row(mine, 1, '1', 'pending');
    await row(other, 0, '1', 'awaiting_approval');

    const result = await createPgZoneDeleter(pool)(mine.accountId, zone, AT);

    expect(result).toEqual({ deleted: true, cancelled: 3 });
    expect(await deletedAt(zone)).toEqual(new Date(AT));
    expect(await deletedAt(sibling)).toBeNull();
    expect(await statuses()).toEqual({
      [`${zone}/1`]: 'cancelled_erasure',
      [`${zone}/2`]: 'cancelled_erasure',
      [`${zone}/3`]: 'cancelled_erasure',
      [`${zone}/4`]: 'sent',
      [`${sibling}/1`]: 'pending',
      [`${foreign}/1`]: 'awaiting_approval',
    });
  });

  it("refuses another account's zone, an already deleted zone and an erased account", async () => {
    const mine = await seed(1);
    const other = await seed(1);
    const [zone = ''] = mine.zoneIds;
    await row(mine, 0, '1', 'pending');
    const deleter = createPgZoneDeleter(pool);

    expect(await deleter(other.accountId, zone, AT)).toEqual({ deleted: false, cancelled: 0 });
    expect(await statuses()).toEqual({ [`${zone}/1`]: 'pending' });

    expect(await deleter(mine.accountId, zone, AT)).toEqual({ deleted: true, cancelled: 1 });
    expect(await deleter(mine.accountId, zone, AT)).toEqual({ deleted: false, cancelled: 0 });

    const gone = await seed(1);
    await db.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [gone.accountId]);
    expect(await deleter(gone.accountId, gone.zoneIds[0] ?? '', AT)).toEqual({
      deleted: false,
      cancelled: 0,
    });
    expect(await deletedAt(gone.zoneIds[0] ?? '')).toBeNull();
  });

  it('waits for a digest pass holding the account, then deletes', async () => {
    const mine = await seed(1);
    const [zone = ''] = mine.zoneIds;
    const pass = new Client({ connectionString: databaseUrl });
    await pass.connect();
    try {
      await pass.query('BEGIN');
      await pass.query('SELECT 1 FROM accounts WHERE id = $1 FOR SHARE', [mine.accountId]);

      let settled = false;
      const deleting = createPgZoneDeleter(pool)(mine.accountId, zone, AT).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      // The pass writes its digest row for the zone while it still holds the account.
      await pass.query(
        `INSERT INTO alert_outbox (
           watch_zone_id, fire_event_id, alert_type, alert_subkey, trigger_type,
           trigger_ref_seq, rule_version, template_id, channel, channel_subscription_id,
           priority, status, decided_at
         ) VALUES ($1, $2, 'digest', '2026-08-14T06:00:00Z', 'digest', 1, 'digest_params_v1',
                   'digest.bg.v1', 'push', $3, 30, 'pending', now())`,
        [zone, eventId, mine.subscriptionId],
      );
      await pass.query('COMMIT');

      expect(await deleting).toEqual({ deleted: true, cancelled: 1 });
      expect(Object.values(await statuses())).toEqual(['cancelled_erasure']);
    } finally {
      await pass.end();
    }
  });
});
