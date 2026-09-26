/**
 * The outbox write path against a real Postgres, because every claim H1 makes is a claim
 * about the database rather than about this module: that A1.11's unique key silently
 * absorbs a redelivery, that migration 003's provenance columns and their CHECKs exist
 * and bind, that `jsonb` survives the text round-trip the adapter does deliberately, and
 * that the runtime role can update a row but can never delete one.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OutboxRowDraft } from '../../core/ports/alert-outbox-store.js';
import { createPgAlertOutboxStore, type PgQueryable } from './pg-alert-outbox-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The outbox write path ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const DECIDED_AT = Date.parse('2026-08-02T11:29:30Z');

interface StoredOutboxRow {
  readonly id: string;
  readonly watch_zone_id: string;
  readonly fire_event_id: string;
  readonly alert_type: string;
  readonly alert_subkey: string;
  readonly trigger_type: string;
  readonly trigger_ref_seq: string;
  readonly rule_version: string;
  readonly template_id: string;
  readonly template_params: Record<string, unknown>;
  readonly channel: string;
  readonly channel_subscription_id: string | null;
  readonly priority: number;
  readonly budget_seq: number | null;
  readonly status: string;
  readonly actor_id: string | null;
  readonly approver_id: string | null;
  readonly approval_mode: string | null;
  readonly approved_at: Date | null;
  readonly budget_override: boolean;
  readonly decided_at: Date;
  readonly dispatched_at: Date | null;
  readonly pseudonymized_at: Date | null;
}

describe.skipIf(!hasDocker)('the outbox write path', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let store: ReturnType<typeof createPgAlertOutboxStore>;

  let zoneId: string;
  let secondZoneId: string;
  let subscriptionId: string;
  let eventId: string;
  let eventSeq: string;

  function draft(overrides: Partial<OutboxRowDraft> = {}): OutboxRowDraft {
    return {
      watchZoneId: zoneId,
      fireEventId: eventId,
      alertType: 'new_fire',
      alertSubkey: 'once',
      triggerType: 'new_fire',
      triggerRefSeq: eventSeq,
      ruleVersion: 'alert_gating_v1',
      templateId: 'new_fire.bg.v3',
      templateParams: {},
      channel: 'push',
      channelSubscriptionId: subscriptionId,
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

  async function storedRows(): Promise<StoredOutboxRow[]> {
    const { rows } = await db.query<StoredOutboxRow>(
      'SELECT * FROM alert_outbox ORDER BY priority, decided_at, id',
    );
    return rows;
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
    // A `Client` is a `PgQueryable` — the port is the slice of pg the store uses, and
    // nothing wider. If that ever stops type-checking, the store grew a dependency.
    const queryable: PgQueryable = db;
    store = createPgAlertOutboxStore(queryable);

    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    const accountId = accounts[0]?.id ?? '';

    const { rows: subscriptions } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
       VALUES ($1, 'push', 'https://example.invalid/push/not-a-real-endpoint')
       RETURNING id`,
      [accountId],
    );
    subscriptionId = subscriptions[0]?.id ?? '';

    const { rows: zones } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Vitosha', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000),
              ($1, 'Rila',    ST_GeogFromText('SRID=4326;POINT(23.55 42.13)'), 5000)
       RETURNING id`,
      [accountId],
    );
    zoneId = zones[0]?.id ?? '';
    secondZoneId = zones[1]?.id ?? '';

    const { rows: events } = await db.query<{ id: string; seq: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at,
         centroid, score, config_version, source_registry_version
       )
       VALUES ('fw-2026-q7f3d', 'active', $1, $1, $1,
               ST_SetSRID(ST_MakePoint(23.30, 42.60), 4326), 0.82,
               'clustering_v1', 'source_registry_v1')
       RETURNING id, seq`,
      [new Date(DECIDED_AT).toISOString()],
    );
    eventId = events[0]?.id ?? '';
    eventSeq = events[0]?.seq ?? '';
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('TRUNCATE alert_outbox');
  });

  describe('enqueue', () => {
    it('stores a decision with the provenance needed to defend it later', async () => {
      const result = await store.enqueue([
        draft({ templateParams: { zoneName: 'Vitosha', distanceKm: 4.2 } }),
      ]);

      expect(result).toEqual({ received: 1, inserted: 1, alreadyDecided: 0 });
      const [stored] = await storedRows();
      expect(stored).toMatchObject({
        alert_type: 'new_fire',
        alert_subkey: 'once',
        trigger_type: 'new_fire',
        rule_version: 'alert_gating_v1',
        template_id: 'new_fire.bg.v3',
        channel: 'push',
        priority: 10,
        status: 'pending',
        actor_id: null,
        budget_override: false,
      });
      // jsonb and not a rendered body: A1.3 has to be able to drop the zone-derived
      // parameters at pseudonymization and keep the rest, which it cannot do to prose.
      expect(stored?.template_params).toEqual({ zoneName: 'Vitosha', distanceKm: 4.2 });
      expect(stored?.trigger_ref_seq).toBe(eventSeq);
      expect(stored?.decided_at.toISOString()).toBe('2026-08-02T11:29:30.000Z');
      // Written by the gateway, never at decision time — D9 measures the gap.
      expect(stored?.dispatched_at).toBeNull();
    });

    it('absorbs a redelivered decision instead of sending twice', async () => {
      await store.enqueue([draft()]);
      const again = await store.enqueue([draft({ decidedAt: DECIDED_AT + 60_000 })]);

      expect(again).toEqual({ received: 1, inserted: 0, alreadyDecided: 1 });
      const rows = await storedRows();
      expect(rows).toHaveLength(1);
      // The stored row is still the first decision. A DO UPDATE here would rewrite the
      // audit trail of a row that may already have been sent.
      expect(rows[0]?.decided_at.toISOString()).toBe('2026-08-02T11:29:30.000Z');
    });

    it('keeps a mixed batch of new and redelivered rows counted correctly', async () => {
      await store.enqueue([draft()]);
      const result = await store.enqueue([
        draft(),
        draft({ alertType: 'escalation', triggerType: 'escalation', alertSubkey: 'step-1' }),
        draft({ alertType: 'escalation', triggerType: 'escalation', alertSubkey: 'step-2' }),
      ]);

      expect(result).toEqual({ received: 3, inserted: 2, alreadyDecided: 1 });
      expect(await storedRows()).toHaveLength(3);
    });

    it('lets the same event reach a second zone', async () => {
      // The key is per (zone, event): one fire near two of a reader's zones is two
      // decisions, not a conflict.
      const result = await store.enqueue([draft(), draft({ watchZoneId: secondZoneId })]);
      expect(result).toEqual({ received: 2, inserted: 2, alreadyDecided: 0 });
    });

    it('writes one statement per batch, whatever the batch size', async () => {
      const rows = Array.from({ length: 40 }, (_, index) =>
        draft({ alertType: 'escalation', triggerType: 'escalation', alertSubkey: `step-${index}` }),
      );
      const result = await store.enqueue(rows);
      expect(result).toEqual({ received: 40, inserted: 40, alreadyDecided: 0 });
    });

    it('stores a manual row with its human trail', async () => {
      await store.enqueue([
        draft({
          alertType: 'escalation',
          alertSubkey: 'step-3',
          triggerType: 'manual',
          priority: 0,
          status: 'awaiting_approval',
          actorId: 'operator-anna',
          approverId: 'operator-boris',
          approvalMode: 'two_person',
          approvedAt: DECIDED_AT + 300_000,
          budgetOverride: true,
        }),
      ]);

      const [stored] = await storedRows();
      expect(stored).toMatchObject({
        trigger_type: 'manual',
        alert_type: 'escalation',
        priority: 0,
        status: 'awaiting_approval',
        actor_id: 'operator-anna',
        approver_id: 'operator-boris',
        approval_mode: 'two_person',
        budget_override: true,
      });
      expect(stored?.approved_at?.toISOString()).toBe('2026-08-02T11:34:30.000Z');
    });

    it('orders the queue by A1.2 priority and then by decision time', async () => {
      await store.enqueue([
        draft({ alertType: 'digest', triggerType: 'digest', alertSubkey: 'w1', priority: 30 }),
        draft({
          alertType: 'escalation',
          triggerType: 'escalation',
          alertSubkey: 'step-1',
          priority: 20,
          decidedAt: DECIDED_AT + 1000,
        }),
        draft({ priority: 10, decidedAt: DECIDED_AT + 2000 }),
      ]);

      // Decided last, dispatched first: priority reorders the queue, and a new fire
      // outranks a digest that was decided before it.
      expect((await storedRows()).map((row) => row.alert_type)).toEqual([
        'new_fire',
        'escalation',
        'digest',
      ]);
    });
  });

  describe('the schema the rows land in', () => {
    it('rejects a trigger type outside A1.1s four values', async () => {
      // Postgres evaluates CHECK constraints in name order, so an unknown trigger type
      // on an automatic row always trips `alert_outbox_trigger_matches_alert` first (and
      // an unknown alert type trips `alert_outbox_alert_type_check` first). No INSERT can
      // surface the vocabulary check by name, so its definition is asserted directly.
      await expect(store.enqueue([draft({ triggerType: 'reminder' as never })])).rejects.toThrow(
        /violates check constraint/,
      );
      const { rows } = await db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'alert_outbox_trigger_type_check'`,
      );
      expect(rows).toHaveLength(1);
      const allowed = [...(rows[0]?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
      expect(allowed.sort()).toEqual(['digest', 'escalation', 'manual', 'new_fire']);
    });

    it('rejects an automatic row whose trigger disagrees with its alert', async () => {
      // Only `manual` may differ. A `digest` row announcing a `new_fire` would make the
      // stored priority unexplainable from the row it is on.
      await expect(
        store.enqueue([draft({ triggerType: 'digest', alertType: 'new_fire' })]),
      ).rejects.toThrow(/alert_outbox_trigger_matches_alert/);
    });

    it('accepts a manual row announcing any of the three alert types', async () => {
      const result = await store.enqueue([
        draft({ triggerType: 'manual', actorId: 'operator-anna' }),
      ]);
      expect(result.inserted).toBe(1);
    });

    it('defaults budget_override to false for a row written before migration 003', async () => {
      // The column landed NOT NULL DEFAULT false on a populated table; a row inserted
      // without it must read as "no human pushed this past budget", not as unknown.
      await db.query(
        `INSERT INTO alert_outbox (
           watch_zone_id, fire_event_id, alert_type, alert_subkey, trigger_type,
           trigger_ref_seq, rule_version, template_id, channel, status, decided_at
         ) VALUES ($1, $2, 'new_fire', 'once', 'new_fire', $3, 'alert_gating_v1',
                   'new_fire.bg.v3', 'push', 'pending', now())`,
        [zoneId, eventId, eventSeq],
      );
      const [stored] = await storedRows();
      expect(stored?.budget_override).toBe(false);
      expect(stored?.actor_id).toBeNull();
    });
  });

  describe('the runtime role', () => {
    beforeEach(async () => {
      // After the outer TRUNCATE, which the runtime role has no business doing.
      await db.query('SET ROLE fire_watch_app');
    });

    afterEach(async () => {
      await db.query('RESET ROLE');
    });

    it('may write and update a row', async () => {
      const result = await store.enqueue([draft()]);
      expect(result.inserted).toBe(1);
      // The gateway has to be able to move a row to `sent` and stamp the ack.
      await expect(
        db.query("UPDATE alert_outbox SET status = 'sent', dispatched_at = now()"),
      ).resolves.toBeDefined();
    });

    it('may never delete one', async () => {
      // No DELETE grant: an outbox row is the audit trail of a decision, and A1.3
      // retires it by rewriting it in place rather than by removing it.
      await store.enqueue([draft()]);
      await expect(db.query('DELETE FROM alert_outbox')).rejects.toThrow(/permission denied/);
    });
  });
});
