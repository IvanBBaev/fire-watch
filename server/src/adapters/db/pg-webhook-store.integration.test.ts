/**
 * The webhook stores against a real Postgres (migration 035): the per-account cap under
 * concurrency, the subscription each endpoint routes through, the ping that confirms and
 * re-enables, the failure count that disables and revokes, a 410 that disables at once,
 * removal (revoked and scrubbed subscription, cascaded log), and the alert facts read from
 * a real outbox row. The recipient resolver's liveness rule is asserted through the
 * subscription columns it reads.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WebhookAttemptRecord } from '../../core/ports/webhook-store.js';
import { createPgWebhookDeliveryStore, createPgWebhookEndpointStore } from './pg-webhook-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The webhook stores ' +
      'are only ever executed here, so skipping them in CI is a false green.',
  );
}

const NOW = Date.parse('2026-10-27T09:00:00Z');
const SEALED = { ciphertext: new Uint8Array(60).fill(9), keyId: 'webhook2026a' };

describe.skipIf(!hasDocker)('the webhook stores', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  async function account(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    return rows[0]?.id ?? '';
  }

  async function subscriptionOf(endpointId: string) {
    const { rows } = await pool.query<{
      endpoint: string;
      confirmed_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT s.endpoint, s.confirmed_at, s.revoked_at
       FROM channel_subscriptions s
       WHERE s.channel = 'webhook' AND s.id = (
         SELECT channel_subscription_id FROM webhook_endpoints WHERE id = $1)`,
      [endpointId],
    );
    return rows[0];
  }

  async function registered(accountId: string): Promise<string> {
    const id = randomUUID();
    const created = await createPgWebhookEndpointStore(pool).create(
      { id, accountId, url: 'https://hooks.example.org/fw', sealed: SEALED, atMs: NOW },
      5,
    );
    expect(created).toBe(true);
    return id;
  }

  function attempt(
    accountId: string,
    endpointId: string,
    overrides: Partial<WebhookAttemptRecord> = {},
  ): WebhookAttemptRecord {
    return {
      endpointId,
      accountId,
      kind: 'ping',
      outboxId: null,
      deliveryId: randomUUID(),
      attempt: 1,
      attemptedAtMs: NOW,
      durationMs: 10,
      outcome: 'delivered',
      statusCode: 200,
      error: null,
      nextAttemptAtMs: null,
      ...overrides,
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('holds the per-account cap under concurrent creates', async () => {
    const accountId = await account();
    const store = createPgWebhookEndpointStore(pool);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.create(
          {
            id: randomUUID(),
            accountId,
            url: 'https://hooks.example.org/fw',
            sealed: SEALED,
            atMs: NOW,
          },
          5,
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await store.list(accountId)).toHaveLength(5);
  });

  it('routes through an unconfirmed subscription keyed by the endpoint id until a ping lands', async () => {
    const accountId = await account();
    const id = await registered(accountId);
    const before = await subscriptionOf(id);
    expect(before?.endpoint).toBe(id);
    expect(before?.confirmed_at).toBeNull();
    const view = await createPgWebhookEndpointStore(pool).get(accountId, id);
    expect(view?.confirmed).toBe(false);

    const deliveries = createPgWebhookDeliveryStore(pool);
    const result = await deliveries.recordAttempt(attempt(accountId, id), {
      kind: 'success',
      confirm: true,
    });
    expect(result).toEqual({ disabled: false });
    expect((await subscriptionOf(id))?.confirmed_at?.getTime()).toBe(NOW);
    expect((await createPgWebhookEndpointStore(pool).get(accountId, id))?.confirmed).toBe(true);

    // Another account reads it as absent.
    const stranger = await account();
    expect(await createPgWebhookEndpointStore(pool).get(stranger, id)).toBeNull();
    expect(await createPgWebhookEndpointStore(pool).remove(stranger, id, NOW)).toBe(false);
  });

  it('disables after the failure cap, revokes, and a confirming ping brings it back', async () => {
    const accountId = await account();
    const id = await registered(accountId);
    const deliveries = createPgWebhookDeliveryStore(pool);
    const deliveryId = randomUUID();
    const outcomes = await Promise.all(
      [1, 2, 3].map((n) =>
        deliveries.recordAttempt(
          attempt(accountId, id, {
            kind: 'ping',
            deliveryId,
            attempt: n,
            outcome: 'failed',
            statusCode: 500,
            attemptedAtMs: NOW + n,
          }),
          { kind: 'failure', disableAfter: 3 },
        ),
      ),
    );
    expect(outcomes.filter((o) => o.disabled)).toHaveLength(1);
    const view = await createPgWebhookEndpointStore(pool).get(accountId, id);
    expect(view?.consecutiveFailures).toBe(3);
    expect(view?.disabledReason).toBe('consecutive_failures');
    expect((await subscriptionOf(id))?.revoked_at).not.toBeNull();
    expect((await subscriptionOf(id))?.endpoint).toBe(id);
    expect(await deliveries.lastAttempt(id, deliveryId)).toEqual({
      attempt: 3,
      nextAttemptAt: null,
    });

    await deliveries.recordAttempt(attempt(accountId, id, { attemptedAtMs: NOW + 10 }), {
      kind: 'success',
      confirm: true,
    });
    const back = await createPgWebhookEndpointStore(pool).get(accountId, id);
    expect(back?.disabledAtMs).toBeNull();
    expect(back?.consecutiveFailures).toBe(0);
    expect((await subscriptionOf(id))?.revoked_at).toBeNull();
    expect((await deliveries.loadTarget(id))?.disabled).toBe(false);
  });

  it('disables at once on a 410 and keeps the retry schedule in the log', async () => {
    const accountId = await account();
    const id = await registered(accountId);
    const deliveries = createPgWebhookDeliveryStore(pool);
    await deliveries.recordAttempt(
      attempt(accountId, id, {
        deliveryId: 'd-1',
        outcome: 'retry',
        statusCode: 503,
        nextAttemptAtMs: NOW + 60_000,
      }),
      { kind: 'failure', disableAfter: 20 },
    );
    expect(await deliveries.lastAttempt(id, 'd-1')).toEqual({
      attempt: 1,
      nextAttemptAt: NOW + 60_000,
    });
    const gone = await deliveries.recordAttempt(
      attempt(accountId, id, { deliveryId: 'd-1', attempt: 2, outcome: 'gone', statusCode: 410 }),
      { kind: 'disable', reason: 'gone' },
    );
    expect(gone).toEqual({ disabled: true });
    expect((await createPgWebhookEndpointStore(pool).get(accountId, id))?.disabledReason).toBe(
      'gone',
    );
  });

  it('removes the endpoint, cascades its log and revokes and scrubs its subscription', async () => {
    const accountId = await account();
    const id = await registered(accountId);
    const { rows: subs } = await pool.query<{ id: string }>(
      'SELECT channel_subscription_id::text AS id FROM webhook_endpoints WHERE id = $1',
      [id],
    );
    const subscriptionId = subs[0]?.id ?? '';
    const deliveries = createPgWebhookDeliveryStore(pool);
    await deliveries.recordAttempt(attempt(accountId, id), { kind: 'none' });
    expect(await createPgWebhookEndpointStore(pool).remove(accountId, id, NOW)).toBe(true);
    expect(await createPgWebhookEndpointStore(pool).remove(accountId, id, NOW)).toBe(false);
    const { rows: logs } = await pool.query(
      'SELECT 1 FROM webhook_deliveries WHERE webhook_endpoint_id = $1',
      [id],
    );
    expect(logs).toHaveLength(0);
    const { rows } = await pool.query<{ endpoint: string; revoked_at: Date | null }>(
      'SELECT endpoint, revoked_at FROM channel_subscriptions WHERE id = $1',
      [subscriptionId],
    );
    expect(rows[0]?.endpoint).toBe('');
    expect(rows[0]?.revoked_at?.getTime()).toBe(NOW);
    expect(await deliveries.loadTarget(id)).toBeNull();
    // An attempt racing the delete records nothing.
    expect(await deliveries.recordAttempt(attempt(accountId, id), { kind: 'none' })).toEqual({
      disabled: true,
    });
  });

  it('rotates the sealed secret and reads alert facts from a real outbox row', async () => {
    const accountId = await account();
    const id = await registered(accountId);
    const rotated = { ciphertext: new Uint8Array(70).fill(3), keyId: 'webhook2026b' };
    expect(
      await createPgWebhookEndpointStore(pool).rotateSecret(accountId, id, rotated, NOW + 5),
    ).toBe(true);
    const target = await createPgWebhookDeliveryStore(pool).loadTarget(id);
    expect(target?.sealed).toEqual(rotated);
    expect((await createPgWebhookEndpointStore(pool).get(accountId, id))?.secretRotatedAtMs).toBe(
      NOW + 5,
    );

    const iso = new Date(NOW).toISOString();
    const { rows: events } = await pool.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at,
         centroid, score, config_version, source_registry_version
       )
       VALUES ('fw-2026-whook', 'active', $1, $1, $1,
               ST_SetSRID(ST_MakePoint(23.30, 42.60), 4326), 0.5,
               'clustering_v1', 'source_registry_v1')
       RETURNING id::text AS id`,
      [iso],
    );
    const { rows: subs } = await pool.query<{ id: string }>(
      'SELECT channel_subscription_id::text AS id FROM webhook_endpoints WHERE id = $1',
      [id],
    );
    const { rows: zones } = await pool.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Home', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000)
       RETURNING id::text AS id`,
      [accountId],
    );
    const { rows: outbox } = await pool.query<{ id: string }>(
      `INSERT INTO alert_outbox (watch_zone_id, fire_event_id, alert_type, alert_subkey,
                                 trigger_type, trigger_ref_seq, rule_version, template_id,
                                 template_params, channel, channel_subscription_id, status,
                                 decided_at)
       VALUES ($1, $2, 'new_fire', 'once', 'new_fire', 1, 'alert_gating_v1', 'new_fire.bg.v3',
               '{}', 'webhook', $3, 'pending', $4)
       RETURNING id::text AS id`,
      [zones[0]?.id, events[0]?.id, subs[0]?.id, iso],
    );
    const outboxId = outbox[0]?.id ?? '';
    const facts = await createPgWebhookDeliveryStore(pool).alertFacts(outboxId);
    expect(facts).toEqual({
      alertType: 'new_fire',
      decidedAtMs: NOW,
      event: {
        publicId: 'fw-2026-whook',
        score: 0.5,
        status: 'active',
        startedAtMs: NOW,
        lastDetectionAtMs: NOW,
      },
    });
    await createPgWebhookDeliveryStore(pool).recordAttempt(
      attempt(accountId, id, { kind: 'alert', outboxId, deliveryId: outboxId }),
      { kind: 'success', confirm: false },
    );
    expect(await createPgWebhookDeliveryStore(pool).lastAttempt(id, outboxId)).toEqual({
      attempt: 1,
      nextAttemptAt: null,
    });
    expect(await createPgWebhookDeliveryStore(pool).alertFacts('999999999')).toBeNull();
  });
});
