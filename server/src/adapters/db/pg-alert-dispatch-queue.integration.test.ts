/**
 * The outbox read path against a real Postgres: that a claim is one statement which both
 * takes and marks its rows, that `SKIP LOCKED` hands a second claimer the *next* rows,
 * that every settle refuses a row some other writer moved first, that the id order is
 * numeric rather than textual, and that the send count G is enforced against is the
 * count of `dispatched_at` stamps.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OutboxRowDraft } from '../../core/ports/alert-outbox-store.js';
import {
  ABANDONED_CLAIM_ERROR,
  EXPIRED_CLAIM_ERROR,
  createPgAlertDispatchQueue,
  createPgSendRateReader,
} from './pg-alert-dispatch-queue.js';
import { createPgAlertOutboxStore } from './pg-alert-outbox-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The outbox read path ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const DECIDED_AT = Date.parse('2026-08-02T11:29:30Z');
const NOW = DECIDED_AT + 60_000;

interface StoredRow {
  readonly id: string;
  readonly status: string;
  readonly last_error: string | null;
  readonly dispatched_at: Date | null;
  readonly provider_ack_at: Date | null;
}

describe.skipIf(!hasDocker)('the outbox read path', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let db: Client;
  let zoneIds: string[];
  let subscriptionId: string;
  let eventId: string;
  let eventSeq: string;

  function draft(index: number, overrides: Partial<OutboxRowDraft> = {}): OutboxRowDraft {
    return {
      watchZoneId: zoneIds[index] ?? '',
      fireEventId: eventId,
      alertType: 'new_fire',
      alertSubkey: 'once',
      triggerType: 'new_fire',
      triggerRefSeq: eventSeq,
      ruleVersion: 'alert_gating_v1',
      templateId: 'new_fire.bg.v3',
      templateParams: { distanceKm: 4.2 },
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

  async function enqueue(...drafts: OutboxRowDraft[]): Promise<void> {
    await createPgAlertOutboxStore(db).enqueue(drafts);
  }

  async function stored(): Promise<StoredRow[]> {
    const { rows } = await db.query<StoredRow>(
      `SELECT id::text AS id, status, last_error, dispatched_at, provider_ack_at
       FROM alert_outbox ORDER BY id`,
    );
    return rows;
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

    // Twelve zones, so the same event yields twelve rows and ids cross from 9 to 10 —
    // the boundary a textual sort would get wrong.
    const { rows: zones } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       SELECT $1, 'Zone ' || n, ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000
       FROM generate_series(1, 12) AS n
       RETURNING id`,
      [accountId],
    );
    zoneIds = zones.map((zone) => zone.id);

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
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    // RESTART IDENTITY so every test's ids start at 1 and the 9/10 boundary is known.
    await db.query('TRUNCATE alert_outbox RESTART IDENTITY');
  });

  describe('claim', () => {
    it('takes pending rows in stored order and marks them claimed in the same statement', async () => {
      await enqueue(draft(0, { priority: 20 }), draft(1, { priority: 10 }), draft(2));
      const queue = createPgAlertDispatchQueue(db);

      const claimed = await queue.claim(2, NOW);

      expect(claimed.map((row) => [row.id, row.priority])).toEqual([
        ['2', 10],
        ['3', 10],
      ]);
      expect(claimed[0]).toMatchObject({
        status: 'claimed',
        templateParams: { distanceKm: 4.2 },
        channelSubscriptionId: subscriptionId,
        decidedAt: DECIDED_AT,
        claimedAt: NOW,
        locale: 'bg',
      });
      expect((await stored()).map((row) => row.status)).toEqual(['pending', 'claimed', 'claimed']);
    });

    it('orders ids as numbers, not as text', async () => {
      await enqueue(...zoneIds.map((_, index) => draft(index)));
      const claimed = await createPgAlertDispatchQueue(db).claim(12, NOW);
      expect(claimed.map((row) => row.id)).toEqual(
        Array.from({ length: 12 }, (_, index) => String(index + 1)),
      );
    });

    it('never takes a row decided after now, awaiting approval, or already claimed', async () => {
      await enqueue(
        draft(0, { decidedAt: NOW + 1 }),
        draft(1, { status: 'awaiting_approval', budgetSeq: 600 }),
        draft(2),
      );
      const queue = createPgAlertDispatchQueue(db);
      expect((await queue.claim(10, NOW)).map((row) => row.id)).toEqual(['3']);
      expect(await queue.claim(10, NOW)).toEqual([]);
    });

    it('skips rows another transaction holds instead of waiting for them', async () => {
      await enqueue(draft(0), draft(1));
      const other = new Client({ connectionString: databaseUrl });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query('SELECT id FROM alert_outbox WHERE id = 1 FOR UPDATE');

        const claimed = await createPgAlertDispatchQueue(db).claim(2, NOW);
        expect(claimed.map((row) => row.id)).toEqual(['2']);
      } finally {
        await other.query('ROLLBACK');
        await other.end();
      }
    });
  });

  describe('settle', () => {
    it('records a send with both timestamps', async () => {
      await enqueue(draft(0));
      const queue = createPgAlertDispatchQueue(db);
      await queue.claim(1, NOW);

      await queue.settle('1', { kind: 'sent', dispatchedAt: NOW, providerAckAt: NOW + 250 });

      const [row] = await stored();
      expect(row?.status).toBe('sent');
      expect(row?.dispatched_at?.getTime()).toBe(NOW);
      expect(row?.provider_ack_at?.getTime()).toBe(NOW + 250);
    });

    it('records a close and a release', async () => {
      await enqueue(draft(0), draft(1));
      const queue = createPgAlertDispatchQueue(db);
      await queue.claim(2, NOW);

      await queue.settle('1', {
        kind: 'closed',
        status: 'failed',
        error: 'provider said 410',
        dispatchedAt: NOW,
      });
      await queue.settle('2', { kind: 'released', error: 'rate limited' });

      expect(await stored()).toMatchObject([
        { id: '1', status: 'failed', last_error: 'provider said 410' },
        { id: '2', status: 'pending', last_error: 'rate limited', dispatched_at: null },
      ]);
    });

    it('refuses to overwrite an erasure that landed while the row was claimed', async () => {
      await enqueue(draft(0));
      const queue = createPgAlertDispatchQueue(db);
      await queue.claim(1, NOW);
      // A1.9's deletion transaction, racing the provider call.
      await db.query("UPDATE alert_outbox SET status = 'cancelled_erasure' WHERE id = 1");

      await expect(
        queue.settle('1', { kind: 'sent', dispatchedAt: NOW, providerAckAt: NOW }),
      ).rejects.toThrow(/another writer moved it first/);
      expect((await stored())[0]?.status).toBe('cancelled_erasure');
      // And the abandoned-claim sweep leaves it alone too.
      expect(await queue.releaseAbandonedClaims()).toBe(0);
      expect((await stored())[0]?.status).toBe('cancelled_erasure');
    });
  });

  describe('claim expiry', () => {
    it("releases this instance's unsettled claims, and only those", async () => {
      await enqueue(draft(0), draft(1), draft(2));
      const mine = createPgAlertDispatchQueue(db);
      const theirs = createPgAlertDispatchQueue(db);
      await mine.claim(2, NOW);
      await theirs.claim(1, NOW);
      await mine.settle('1', { kind: 'sent', dispatchedAt: NOW, providerAckAt: NOW });

      expect(await mine.releaseAbandonedClaims()).toBe(1);
      expect(await stored()).toMatchObject([
        { id: '1', status: 'sent' },
        { id: '2', status: 'pending', last_error: ABANDONED_CLAIM_ERROR },
        { id: '3', status: 'claimed' },
      ]);
    });

    it('releases claims older than the cutoff, whoever made them, and nothing newer', async () => {
      await enqueue(draft(0), draft(1));
      const crashed = createPgAlertDispatchQueue(db);
      // Both claims are at or after the rows' decided_at: a claim cannot take a row that
      // is not yet due, so the "old" claim is NOW and the newer one 200 s later.
      await crashed.claim(1, NOW);
      await crashed.claim(1, NOW + 200_000);

      // A different process, with no memory of the first one's claims (migration 015).
      expect(await createPgAlertDispatchQueue(db).releaseExpiredClaims(NOW + 80_000)).toBe(1);
      expect(await stored()).toMatchObject([
        { id: '1', status: 'pending', last_error: EXPIRED_CLAIM_ERROR },
        { id: '2', status: 'claimed' },
      ]);
    });

    it('fences a dispatcher that outlived its lease out of the claim that replaced it', async () => {
      await enqueue(draft(0));
      const stale = createPgAlertDispatchQueue(db);
      await stale.claim(1, NOW);
      const fresh = createPgAlertDispatchQueue(db);
      expect(await fresh.releaseExpiredClaims(NOW + 80_000)).toBe(1);
      expect(await fresh.claim(1, NOW + 200_000)).toHaveLength(1);

      await expect(
        stale.settle('1', { kind: 'sent', dispatchedAt: NOW, providerAckAt: NOW }),
      ).rejects.toThrow(/another writer moved it first/);
      expect(await stale.releaseAbandonedClaims()).toBe(0);
      expect((await stored())[0]?.status).toBe('claimed');

      await fresh.settle('1', { kind: 'sent', dispatchedAt: NOW, providerAckAt: NOW });
      expect((await stored())[0]?.status).toBe('sent');
    });

    it('refuses a claimed row without a claim instant (migration 015 CHECK)', async () => {
      await enqueue(draft(0));
      await expect(db.query("UPDATE alert_outbox SET status = 'claimed'")).rejects.toThrow(
        /alert_outbox_claim_has_lease/,
      );
    });
  });

  describe('the send-rate reader', () => {
    it('counts provider hand-offs in the window, sent or failed, and nothing released', async () => {
      await enqueue(draft(0), draft(1), draft(2), draft(3));
      const queue = createPgAlertDispatchQueue(db);
      await queue.claim(4, NOW);
      await queue.settle('1', { kind: 'sent', dispatchedAt: NOW, providerAckAt: NOW });
      await queue.settle('2', {
        kind: 'closed',
        status: 'failed',
        error: '410',
        dispatchedAt: NOW,
      });
      await queue.settle('3', { kind: 'released', error: 'timeout' });
      await queue.settle('4', {
        kind: 'sent',
        dispatchedAt: NOW - 700_000,
        providerAckAt: NOW - 700_000,
      });

      const reader = createPgSendRateReader(db);
      expect(await reader.sendsSince(NOW - 600_000)).toBe(2);
      expect(await reader.sendsSince(NOW - 800_000)).toBe(3);
    });
  });
});
