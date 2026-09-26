/**
 * The meta-alert monitor reader against a real Postgres (TASKS J1).
 *
 * What only the database can prove: that the outbox aggregate counts a pending row only
 * once it is due and ignores settled rows; and that the identity-lag aggregate agrees,
 * batch for batch, with the clustering store's own pending-batch cursor — the two copies
 * of that predicate are held together here.
 *
 * Skipped when there is no Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that
 * skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CLUSTERING_PARAMS } from '../../core/clustering/clustering-params.js';
import type { OutboxRowDraft } from '../../core/ports/alert-outbox-store.js';
import { createPgAlertOutboxStore } from './pg-alert-outbox-store.js';
import { createPgClusteringStore } from './pg-clustering-store.js';
import { createPgMonitorReader } from './pg-monitor-reader.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The monitor SQL is ' +
      'only ever executed here, so skipping it in CI is a false green.',
  );
}

const SNPP = 'firms:viirs:snpp';
const NOAA20 = 'firms:viirs:noaa20';
const NOW = Date.parse('2026-09-23T10:00:00Z');
const MINUTE = 60_000;

describe.skipIf(!hasDocker)('the meta-alert monitor reader', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
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
      decidedAt: NOW - MINUTE,
      locale: 'bg',
      ...overrides,
    };
  }

  async function insertBatch(source: string, availableAt: number, recordedAt: number) {
    await pool.query(
      `INSERT INTO ingest_batches (
         source, available_at, recorded_at, received, inserted, already_present, rejected,
         quarantined, anomaly_verdict, anomaly_tripped, baseline, ratio,
         ingest_config_version, polling_bbox_version, source_registry_version
       ) VALUES ($1, $2, $3, 0, 0, 0, 0, 0, 'not_enough_history', false, NULL, NULL,
                 'ingest_v1', 'bbox_v1', 'sources_v1')`,
      [source, new Date(availableAt), new Date(recordedAt)],
    );
  }

  async function ledger(runId: number, source: string, availableAt: number) {
    await pool.query(
      `INSERT INTO clustering_batches (
         clustering_run_id, source, available_at, detections, seeded, attached, merged,
         unattached, already_assigned
       ) VALUES ($1, $2, $3, 0, 0, 0, 0, 0, 0)`,
      [runId, source, new Date(availableAt)],
    );
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    pool = new Pool({ connectionString: databaseUrl });

    const { rows: accounts } = await pool.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    const accountId = accounts[0]?.id ?? '';
    const { rows: subscriptions } = await pool.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
       VALUES ($1, 'push', 'https://example.invalid/push/not-a-real-endpoint')
       RETURNING id`,
      [accountId],
    );
    subscriptionId = subscriptions[0]?.id ?? '';
    const { rows: zones } = await pool.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       SELECT $1, 'Zone ' || n, ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000
       FROM generate_series(1, 6) AS n
       RETURNING id`,
      [accountId],
    );
    zoneIds = zones.map((zone) => zone.id);
    const { rows: events } = await pool.query<{ id: string; seq: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at,
         centroid, score, config_version, source_registry_version
       )
       VALUES ('fw-2026-m0n1t', 'active', $1, $1, $1,
               ST_SetSRID(ST_MakePoint(23.30, 42.60), 4326), 0.82,
               'clustering_v1', 'source_registry_v1')
       RETURNING id, seq`,
      [new Date(NOW - 60 * MINUTE)],
    );
    eventId = events[0]?.id ?? '';
    eventSeq = events[0]?.seq ?? '';
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  describe('outbox queue', () => {
    beforeEach(async () => {
      await pool.query('TRUNCATE alert_outbox RESTART IDENTITY');
    });

    it('reads an empty queue as empty', async () => {
      expect(await createPgMonitorReader(pool).readOutboxQueue(NOW)).toEqual({
        pendingCount: 0,
        claimedCount: 0,
        oldestUnsentDecidedAt: null,
        oldestClaimedDecidedAt: null,
        awaitingApprovalCount: 0,
        oldestAwaitingDecidedAt: null,
      });
    });

    it('counts due pending and claimed rows, not scheduled or settled ones', async () => {
      await createPgAlertOutboxStore(pool).enqueue([
        draft(0, { decidedAt: NOW - 12 * MINUTE }),
        draft(1, { decidedAt: NOW - 2 * MINUTE }),
        // Scheduled: not late, and not in the queue age.
        draft(2, { decidedAt: NOW + 5 * MINUTE }),
        draft(3, { decidedAt: NOW - 30 * MINUTE, status: 'awaiting_approval', budgetSeq: 600 }),
        draft(4, { decidedAt: NOW - 20 * MINUTE }),
        draft(5, { decidedAt: NOW - 90 * MINUTE }),
      ]);
      // A claim carries its lease stamp (migration 015's alert_outbox_claim_has_lease).
      await pool.query(
        `UPDATE alert_outbox SET status = 'claimed', claimed_at = now() WHERE watch_zone_id = $1`,
        [zoneIds[4]],
      );
      await pool.query(
        `UPDATE alert_outbox SET status = 'sent', dispatched_at = now(), provider_ack_at = now()
          WHERE watch_zone_id = $1`,
        [zoneIds[5]],
      );

      expect(await createPgMonitorReader(pool).readOutboxQueue(NOW)).toEqual({
        pendingCount: 2,
        claimedCount: 1,
        oldestUnsentDecidedAt: NOW - 20 * MINUTE,
        oldestClaimedDecidedAt: NOW - 20 * MINUTE,
        awaitingApprovalCount: 1,
        oldestAwaitingDecidedAt: NOW - 30 * MINUTE,
      });
    });
  });

  describe('identity lag', () => {
    beforeEach(async () => {
      await pool.query('TRUNCATE clustering_runs, ingest_batches CASCADE');
    });

    it('reports no live run before the identity loop has started', async () => {
      await insertBatch(SNPP, NOW - 10 * MINUTE, NOW - 9 * MINUTE);
      expect(await createPgMonitorReader(pool).readIdentityLag(NOW - 48 * 60 * MINUTE)).toEqual({
        liveRuns: 0,
        pendingBatches: 0,
        oldestPendingRecordedAt: null,
      });
    });

    it('agrees batch for batch with the clustering store cursor', async () => {
      const store = createPgClusteringStore(pool, CLUSTERING_PARAMS);
      const run = await store.liveRun(CLUSTERING_PARAMS);
      const notBefore = NOW - 48 * 60 * MINUTE;

      // Cold start: only the notBefore bound applies.
      await insertBatch(SNPP, notBefore - MINUTE, NOW - 50 * 60 * MINUTE);
      await insertBatch(SNPP, NOW - 40 * MINUTE, NOW - 39 * MINUTE);
      await insertBatch(NOAA20, NOW - 40 * MINUTE, NOW - 38 * MINUTE);
      await insertBatch(SNPP, NOW - 30 * MINUTE, NOW - 29 * MINUTE);
      await insertBatch(SNPP, NOW - 20 * MINUTE, NOW - 19 * MINUTE);

      const reader = createPgMonitorReader(pool);
      const cold = await reader.readIdentityLag(notBefore);
      const coldExpected = await store.pendingBatches(run, { notBefore, limit: 1_000 });
      expect(cold.liveRuns).toBe(1);
      expect(cold.pendingBatches).toBe(coldExpected.length);
      expect(cold.pendingBatches).toBe(4);
      expect(cold.oldestPendingRecordedAt).toBe(NOW - 39 * MINUTE);

      // The cursor is the (available_at, source) tuple under "C" collation. The NOAA-20
      // batch shares the ledgered SNPP batch's instant, and 'firms:viirs:noaa20' sorts
      // before 'firms:viirs:snpp', so it falls behind the cursor with it.
      await ledger(run.id, SNPP, NOW - 40 * MINUTE);
      const warm = await reader.readIdentityLag(notBefore);
      const warmExpected = await store.pendingBatches(run, { notBefore, limit: 1_000 });
      expect(warm.pendingBatches).toBe(warmExpected.length);
      expect(warm.pendingBatches).toBe(2);
      expect(warm.oldestPendingRecordedAt).toBe(NOW - 29 * MINUTE);

      await ledger(run.id, SNPP, NOW - 20 * MINUTE);
      expect(await reader.readIdentityLag(notBefore)).toEqual({
        liveRuns: 1,
        pendingBatches: 0,
        oldestPendingRecordedAt: null,
      });
    });
  });
});
