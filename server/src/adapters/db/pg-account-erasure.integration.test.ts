/**
 * Account erasure against a real Postgres (TASKS I4; migration 010), run as the runtime
 * role it runs as in production.
 *
 * The drill: deleting an account cancels its pending and claimed outbox rows and
 * pseudonymizes every outbox row of its zones in the same transaction that removes its
 * zones, alert state, channel confirmations, subscriptions, sessions and link requests,
 * tombstones it and writes the ledger. Then the row-lock orderings against the dispatcher's `SKIP LOCKED` claim,
 * and the guards that stop the runtime role from undoing an erasure.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ERASURE_PLAN } from '../../core/erasure/erasure-plan.js';
import type { OutboxRowDraft } from '../../core/ports/alert-outbox-store.js';
import { createPgAccountErasureStore, createPgAccountEraser } from './pg-account-erasure.js';
import { createPgAlertDispatchQueue } from './pg-alert-dispatch-queue.js';
import { createPgAlertOutboxStore } from './pg-alert-outbox-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. Account erasure is ' +
      'only ever executed here, so skipping it in CI is a false green.',
  );
}

// Whole seconds, so the ISO binds carry no milliseconds; real time, because the ledger
// purge guard measures its horizon against the database's now().
const AT = Math.floor(Date.now() / 1000) * 1000;
const DECIDED_AT = AT - 120_000;

interface Seeded {
  readonly accountId: string;
  readonly email: string;
  readonly zoneIds: readonly string[];
  readonly subscriptionId: string;
}

interface OutboxRow {
  readonly id: string;
  readonly status: string;
  readonly watch_zone_id: string | null;
  readonly channel_subscription_id: string | null;
  readonly template_params: Record<string, unknown>;
  readonly pseudonymized_at: Date | null;
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

describe.skipIf(!hasDocker)('account erasure', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  /** The migration owner: seeds the fixture and inspects what the erasure left. */
  let db: Client;
  /** Runtime-role connections, as the route's eraser would hold them. */
  let appPool: Pool;
  let eventId: string;
  let eventSeq: string;

  async function appClient(): Promise<Client> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`SET ROLE ${APP_ROLE}`);
    return client;
  }

  async function seedAccount(zoneCount = 2): Promise<Seeded> {
    const email = `erase-${randomUUID()}@example.org`;
    const { rows: accounts } = await db.query<{ id: string }>(
      `INSERT INTO accounts (timezone, email, email_verified_at)
       VALUES ('Europe/Sofia', $1, $2) RETURNING id`,
      [email, new Date(DECIDED_AT).toISOString()],
    );
    const accountId = accounts[0]?.id ?? '';
    const { rows: subscriptions } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
       VALUES ($1, 'push', 'https://example.invalid/push/not-a-real-endpoint')
       RETURNING id`,
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
      email,
      zoneIds: zones.map((zone) => zone.id),
      subscriptionId: subscriptions[0]?.id ?? '',
    };
  }

  function draft(
    seeded: Seeded,
    zoneIndex: number,
    overrides: Partial<OutboxRowDraft> = {},
  ): OutboxRowDraft {
    return {
      watchZoneId: seeded.zoneIds[zoneIndex] ?? '',
      fireEventId: eventId,
      alertType: 'new_fire',
      alertSubkey: 'once',
      triggerType: 'new_fire',
      triggerRefSeq: eventSeq,
      ruleVersion: 'alert_gating_v1',
      templateId: 'new_fire.bg.v3',
      templateParams: { distanceKm: 4.2 },
      channel: 'push',
      channelSubscriptionId: seeded.subscriptionId,
      priority: 10,
      budgetSeq: null,
      status: 'pending',
      actorId: null,
      approverId: null,
      approvalMode: null,
      approvedAt: null,
      budgetOverride: false,
      decidedAt: DECIDED_AT,
      locale: 'bg',
      ...overrides,
    };
  }

  async function outbox(): Promise<OutboxRow[]> {
    const { rows } = await db.query<OutboxRow>(
      `SELECT id::text AS id, status, watch_zone_id, channel_subscription_id,
              template_params, pseudonymized_at
       FROM alert_outbox ORDER BY id`,
    );
    return rows;
  }

  async function countWhere(sql: string, values: readonly unknown[]): Promise<number> {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${sql}`, [
      ...values,
    ]);
    return rows[0]?.n ?? -1;
  }

  /** Resolves once some backend is waiting on a heavyweight lock. */
  async function someoneWaitsOnALock(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('no backend ever waited on a lock');
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

    appPool = new Pool({ connectionString: databaseUrl, max: 3 });
    // Queued ahead of anything the checkout runs, so every statement is the runtime role's.
    appPool.on('connect', (client) => {
      void client.query(`SET ROLE ${APP_ROLE}`);
    });

    const { rows: events } = await db.query<{ id: string; seq: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at,
         centroid, score, config_version, source_registry_version
       )
       VALUES ('fw-2026-d1spq', 'active', $1, $1, $1,
               ST_SetSRID(ST_MakePoint(23.30, 42.60), 4326), 0.82,
               'clustering_v1', 'source_registry_v1')
       RETURNING id, seq`,
      [new Date(DECIDED_AT).toISOString()],
    );
    eventId = events[0]?.id ?? '';
    eventSeq = events[0]?.seq ?? '';
  }, 300_000);

  afterAll(async () => {
    await appPool?.end();
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    // Each test's claims see only its own rows. TRUNCATE fires no row trigger, so the
    // immutability of pseudonymized rows does not stand in the way of the reset.
    await db.query('TRUNCATE alert_outbox RESTART IDENTITY');
  });

  it('the drill: deletion cancels pending outbox rows in the same transaction that erases the rest', async () => {
    const seeded = await seedAccount(3);
    await createPgAlertOutboxStore(db).enqueue([
      draft(seeded, 0),
      draft(seeded, 1),
      draft(seeded, 2),
    ]);
    // Row 1 is sent, row 2 is claimed and in flight, row 3 is still pending.
    const queue = createPgAlertDispatchQueue(db);
    await queue.claim(2, DECIDED_AT + 1_000);
    await queue.settle('1', {
      kind: 'sent',
      dispatchedAt: DECIDED_AT + 1_000,
      providerAckAt: DECIDED_AT + 1_200,
    });
    await db.query(
      `INSERT INTO alert_states (watch_zone_id, fire_event_id, state) VALUES ($1, $2, 'notified_new')`,
      [seeded.zoneIds[0], eventId],
    );
    await db.query(
      `INSERT INTO account_sessions (token_hash, account_id, ua_family, created_at, last_seen_at, expires_at)
       VALUES (sha256('drill-session'::bytea), $1, 'firefox', $2, $2, $3)`,
      [
        seeded.accountId,
        new Date(DECIDED_AT).toISOString(),
        new Date(AT + 86_400_000).toISOString(),
      ],
    );
    await db.query(
      `INSERT INTO auth_link_requests (email, token_hash, ua_family, requested_at, expires_at)
       VALUES ($1, sha256('drill-link'::bytea), 'firefox', $2, $3)`,
      [seeded.email, new Date(DECIDED_AT).toISOString(), new Date(AT + 900_000).toISOString()],
    );
    // Migration 012: a confirmation of the push subscription, and a Telegram link still
    // pending — it names no subscription, so only the account-keyed delete reaches it.
    await db.query(
      `INSERT INTO channel_confirmations
         (account_id, channel, channel_subscription_id, token_hash, issued_at, expires_at)
       VALUES ($1, 'push', $2, sha256('drill-confirm'::bytea), $3, $4),
              ($1, 'telegram', NULL, sha256('drill-telegram'::bytea), $3, $4)`,
      [
        seeded.accountId,
        seeded.subscriptionId,
        new Date(DECIDED_AT).toISOString(),
        new Date(AT + 86_400_000).toISOString(),
      ],
    );

    const outcome = await createPgAccountEraser(appPool)(seeded.accountId, AT);

    expect(outcome).toEqual({
      status: 'erased',
      erasedAt: AT,
      deadline: AT + 30 * 86_400_000,
      counts: {
        outboxCancelled: 2,
        outboxPseudonymized: 3,
        alertStates: 1,
        shadowAlerts: 0,
        decisionLog: 0,
        digestLog: 0,
        zones: 3,
        channelConfirmations: 2,
        subscriptions: 1,
        sessions: 1,
        linkRequests: 1,
      },
    });

    const rows = await outbox();
    expect(rows.map((row) => row.status)).toEqual([
      'sent',
      'cancelled_erasure',
      'cancelled_erasure',
    ]);
    for (const row of rows) {
      expect(row.watch_zone_id).toBeNull();
      expect(row.channel_subscription_id).toBeNull();
      expect(row.template_params).toEqual({});
      expect(row.pseudonymized_at?.getTime()).toBe(AT);
    }

    expect(await countWhere('watch_zones WHERE account_id = $1', [seeded.accountId])).toBe(0);
    expect(
      await countWhere('alert_states WHERE watch_zone_id = ANY($1::uuid[])', [seeded.zoneIds]),
    ).toBe(0);
    expect(
      await countWhere('channel_confirmations WHERE account_id = $1', [seeded.accountId]),
    ).toBe(0);
    expect(
      await countWhere('channel_subscriptions WHERE account_id = $1', [seeded.accountId]),
    ).toBe(0);
    expect(await countWhere('account_sessions WHERE account_id = $1', [seeded.accountId])).toBe(0);
    expect(await countWhere('auth_link_requests WHERE email = $1', [seeded.email])).toBe(0);

    const { rows: accounts } = await db.query<{
      email: string | null;
      email_verified_at: Date | null;
      deleted_at: Date | null;
    }>('SELECT email, email_verified_at, deleted_at FROM accounts WHERE id = $1', [
      seeded.accountId,
    ]);
    expect(accounts).toEqual([{ email: null, email_verified_at: null, deleted_at: new Date(AT) }]);

    const { rows: ledger } = await db.query<{ counts: Record<string, number>; deadline_at: Date }>(
      'SELECT counts, deadline_at FROM erasure_requests WHERE account_hash = $1',
      [sha256(seeded.accountId)],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.counts).toMatchObject({ outboxCancelled: 2, zones: 3 });
    expect(ledger[0]?.deadline_at.getTime()).toBe(AT + 30 * 86_400_000);

    // Nothing is left for a dispatcher to claim, and the in-flight claim cannot settle.
    expect(await createPgAlertDispatchQueue(db).claim(10, AT)).toEqual([]);
    await expect(
      queue.settle('2', { kind: 'sent', dispatchedAt: AT, providerAckAt: AT }),
    ).rejects.toThrow(/no longer held by this claim/);
  });

  it('a second erasure of the same account is already_erased and changes nothing', async () => {
    const seeded = await seedAccount(1);
    const erase = createPgAccountEraser(appPool);
    await erase(seeded.accountId, AT);
    expect(await erase(seeded.accountId, AT + 1_000)).toEqual({ status: 'already_erased' });
    expect(
      await countWhere('erasure_requests WHERE account_hash = $1', [sha256(seeded.accountId)]),
    ).toBe(1);
  });

  describe('row-lock ordering against the SKIP LOCKED claim', () => {
    it('a claim while the erasure holds the outbox rows skips them, and finds them cancelled after', async () => {
      const seeded = await seedAccount(2);
      await createPgAlertOutboxStore(db).enqueue([draft(seeded, 0), draft(seeded, 1)]);

      const eraser = await appClient();
      try {
        await eraser.query('BEGIN');
        const store = createPgAccountErasureStore(eraser);
        await store.lockAccount(seeded.accountId);
        const zoneIds = await store.lockZones(seeded.accountId);
        const counts = await store.cancelAndPseudonymizeOutbox(
          zoneIds,
          new Date(AT).toISOString(),
          [],
        );
        expect(counts).toEqual({ cancelled: 2, pseudonymized: 2 });

        // The dispatcher does not wait and does not see the uncommitted cancellation.
        expect(await createPgAlertDispatchQueue(db).claim(10, AT)).toEqual([]);
        expect((await outbox()).map((row) => row.status)).toEqual(['pending', 'pending']);

        await eraser.query('COMMIT');
      } finally {
        await eraser.end();
      }

      expect(await createPgAlertDispatchQueue(db).claim(10, AT)).toEqual([]);
      expect((await outbox()).map((row) => row.status)).toEqual([
        'cancelled_erasure',
        'cancelled_erasure',
      ]);
    });

    it('an erasure waits for an open claim, counts the row as cancelled from claimed, and the settle is refused', async () => {
      const seeded = await seedAccount(1);
      await createPgAlertOutboxStore(db).enqueue([draft(seeded, 0)]);

      const dispatcher = new Client({ connectionString: databaseUrl });
      await dispatcher.connect();
      try {
        const queue = createPgAlertDispatchQueue(dispatcher);
        await dispatcher.query('BEGIN');
        expect((await queue.claim(1, AT)).map((row) => row.id)).toEqual(['1']);

        const erasure = createPgAccountEraser(appPool)(seeded.accountId, AT);
        await someoneWaitsOnALock();
        await dispatcher.query('COMMIT');

        const outcome = await erasure;
        expect(outcome).toMatchObject({
          status: 'erased',
          counts: { outboxCancelled: 1, outboxPseudonymized: 1 },
        });
        expect((await outbox()).map((row) => row.status)).toEqual(['cancelled_erasure']);

        await expect(
          queue.settle('1', { kind: 'sent', dispatchedAt: AT, providerAckAt: AT }),
        ).rejects.toThrow(/no longer held by this claim/);
      } finally {
        await dispatcher.query('ROLLBACK').catch(() => undefined);
        await dispatcher.end();
      }
    });

    it('a zone insert racing the erasure waits for it and is then refused', async () => {
      const seeded = await seedAccount(1);
      const eraser = await appClient();
      const writer = await appClient();
      try {
        await eraser.query('BEGIN');
        await createPgAccountErasureStore(eraser).lockAccount(seeded.accountId);

        const insert = writer.query(
          `INSERT INTO watch_zones (account_id, name, area, radius_m)
           VALUES ($1, 'Late', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000)`,
          [seeded.accountId],
        );
        const settled = insert.then(
          () => 'inserted',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        await someoneWaitsOnALock();
        await eraser.query('ROLLBACK');
        // The erasure rolled back: the account is live, so the waiting insert goes through.
        expect(await settled).toBe('inserted');
      } finally {
        await eraser.end();
        await writer.end();
      }

      await createPgAccountEraser(appPool)(seeded.accountId, AT);
      expect(await countWhere('watch_zones WHERE account_id = $1', [seeded.accountId])).toBe(0);
    });
  });

  describe('the runtime role cannot undo an erasure', () => {
    let erased: Seeded;
    let app: Client;

    beforeAll(async () => {
      erased = await seedAccount(1);
      await createPgAccountEraser(appPool)(erased.accountId, AT);
      app = await appClient();
    });

    afterAll(async () => {
      await app?.end();
    });

    it('cannot write a zone, a subscription or a session under the tombstone', async () => {
      await expect(
        app.query(
          `INSERT INTO watch_zones (account_id, name, area, radius_m)
           VALUES ($1, 'Back', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000)`,
          [erased.accountId],
        ),
      ).rejects.toThrow(/account is erased/);
      await expect(
        app.query(
          `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
           VALUES ($1, 'push', 'https://example.invalid/push/again')`,
          [erased.accountId],
        ),
      ).rejects.toThrow(/account is erased/);
      await expect(
        app.query(
          `INSERT INTO account_sessions (token_hash, account_id, ua_family, created_at, last_seen_at, expires_at)
           VALUES (sha256('again'::bytea), $1, 'firefox', now(), now(), now() + interval '1 day')`,
          [erased.accountId],
        ),
      ).rejects.toThrow(/account is erased/);
    });

    it('cannot put an address back on the tombstone or clear its deleted_at', async () => {
      await expect(
        app.query("UPDATE accounts SET email = 'back@example.org' WHERE id = $1", [
          erased.accountId,
        ]),
      ).rejects.toThrow(/erased and cannot be changed/);
      await expect(
        app.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [erased.accountId]),
      ).rejects.toThrow(/erased and cannot be changed/);
    });

    it('cannot move a pseudonymized outbox row back into the queue', async () => {
      // Seeded here: the outer beforeEach empties the outbox before every test.
      const seeded = await seedAccount(1);
      await createPgAlertOutboxStore(db).enqueue([draft(seeded, 0)]);
      await createPgAccountEraser(appPool)(seeded.accountId, AT);
      await expect(app.query("UPDATE alert_outbox SET status = 'pending'")).rejects.toThrow(
        /pseudonymized/,
      );
    });

    it('cannot rewrite or remove a ledger row', async () => {
      await expect(app.query('DELETE FROM erasure_requests')).rejects.toThrow(/permission denied/);
      await expect(app.query("UPDATE erasure_requests SET plan_version = 'x_v1'")).rejects.toThrow(
        /permission denied/,
      );
    });

    it('cannot purge the ledger inside the 30-day horizon, and may outside it', async () => {
      await expect(
        app.query("SELECT purge_erasure_ledger(now() - interval '29 days', 10)"),
      ).rejects.toThrow(/never purged/);
      const { rows } = await app.query<{ purged: number }>(
        "SELECT purge_erasure_ledger(now() - interval '31 days', 10) AS purged",
      );
      expect(rows).toEqual([{ purged: 0 }]);
    });

    it('cannot reuse an erased id, even after removing the tombstone', async () => {
      await app.query('DELETE FROM accounts WHERE id = $1', [erased.accountId]);
      await expect(
        app.query("INSERT INTO accounts (id, timezone) VALUES ($1, 'Europe/Sofia')", [
          erased.accountId,
        ]),
      ).rejects.toThrow(/cannot be reused/);
    });
  });

  it('every personal table in the backup registry has an erasure rule', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "SELECT table_name FROM table_backup_class WHERE class = 'personal' ORDER BY table_name",
    );
    const ruled = new Set(ERASURE_PLAN.map((rule) => rule.table));
    expect(rows.map((row) => row.table_name).filter((table) => !ruled.has(table))).toEqual([]);
  });
});
