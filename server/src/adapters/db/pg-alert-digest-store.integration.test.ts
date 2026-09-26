/**
 * The live digest pass against a real Postgres: migration 018's log and derived watermark,
 * the digestible-pair read over `alert_states` + 014's decision log, the account lock
 * against erasure, and one whole `runAlertDigestCycle` over sealed zones — the only place
 * the SQL of `pg-alert-digest-store.ts` is executed.
 *
 * The pass runs as `fire_watch_app` (every pool connection `SET ROLE`s), so a missing grant
 * — `FOR SHARE` on `accounts` needs UPDATE, the log needs INSERT — fails here rather than
 * in production.
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

import { runAlertDigestCycle } from '../../core/alerts/digest-pass.js';
import { ZONE_MATCH_METRIC } from '../../core/alerts/zone-match.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { AlertDigestRouting } from '../../core/ports/alert-digest-routing.js';
import { ZONE_GRID, indexCellKey } from '../../core/zones/zone-geometry.js';
import { createAesGcmZoneCipher } from '../crypto/aes-gcm-zone-cipher.js';
import { createPgAlertDigestStore } from './pg-alert-digest-store.js';
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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The digest pass SQL ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

// Europe/Sofia is UTC+3 in August: the 09:00 window opens at 06:00Z.
const WINDOW = '2026-08-14T06:00:00Z';
const AT = '2026-08-14T06:05:00Z';
const CREATED = '2026-08-01T00:00:00.000Z';
const CENTRE = { lat: 42.6, lon: 23.3 };
const kmNorth = (km: number): number => CENTRE.lat + km / ZONE_MATCH_METRIC.kmPerDegreeLat;

const cipher = createAesGcmZoneCipher({
  active: { id: 'test-key', key: new Uint8Array(32).fill(7) },
  retired: [],
});

describe.skipIf(!hasDocker)('the live digest pass adapters', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let accountId = '';
  let subscriptionId = '';
  let publicN = 0;

  async function insertEvent(
    lat: number,
    fields: {
      status?: string;
      mergedInto?: string;
      relatedTo?: string;
      invalidated?: boolean;
    } = {},
  ): Promise<{ id: string; publicId: string }> {
    publicN += 1;
    const publicId = `fw-2026-${publicN.toString(36).padStart(5, '0')}`;
    const status = fields.status ?? 'active';
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid, score,
         config_version, source_registry_version, merged_into, related_event_id, relation_kind,
         invalidated, inactive_since
       ) VALUES ($1, $2, $3, $3, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), 0.9,
                 'clustering_v1', 'source_registry_v1', $6, $7,
                 CASE WHEN $7::bigint IS NULL THEN NULL ELSE 'continuation' END,
                 $8, CASE WHEN $2 IN ('active', 'signal_weakening') THEN NULL ELSE $3::timestamptz END)
       RETURNING id::text AS id`,
      [
        publicId,
        status,
        '2026-08-13T10:00:00Z',
        CENTRE.lon,
        lat,
        fields.mergedInto ?? null,
        fields.relatedTo ?? null,
        fields.invalidated ?? false,
      ],
    );
    return { id: rows[0]?.id ?? '', publicId };
  }

  async function insertZone(
    centreLat = CENTRE.lat,
    owner = accountId,
    radiusM = 20_000,
  ): Promise<string> {
    const id = randomUUID();
    const centre = { lat: centreLat, lon: CENTRE.lon };
    await createPgWatchZoneStore(db).insert({
      id,
      accountId: owner,
      name: 'Vitosha',
      radiusM,
      minScore: 0.45,
      sealed: cipher.seal(id, centre),
      coarsened: false,
      gridVersion: ZONE_GRID.version,
      gridCell: indexCellKey(centre, ZONE_GRID.values),
      createdAtIso: CREATED,
    });
    return id;
  }

  async function notify(zoneId: string, eventId: string, state = 'notified_new'): Promise<void> {
    await db.query(
      `INSERT INTO alert_states (watch_zone_id, fire_event_id, state, last_notified_at)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'none' THEN NULL ELSE '2026-08-13T10:00:00Z'::timestamptz END)`,
      [zoneId, eventId, state],
    );
  }

  let deferSeq = 0;
  async function logDefer(zoneId: string, eventId: string, decidedAt: string): Promise<void> {
    deferSeq += 1;
    await db.query(
      `INSERT INTO alert_decision_log (
         watch_zone_id, fire_event_id, trigger_ref_seq, pass, outcome, reason, code,
         alert_type, ladder_step, in_quiet_hours, rule_version, decided_at
       ) VALUES ($1, $2, $4, 'evaluation', 'defer', 'quiet_hours', 'deferred_quiet_hours',
                 'new_fire', 0, true, 'alert_gating_v1', $3)`,
      [zoneId, eventId, decidedAt, deferSeq],
    );
  }

  const routing = (): AlertDigestRouting => ({
    targetFor: () => Promise.resolve({ channel: 'push', channelSubscriptionId: subscriptionId }),
    digestCopyFor: (group) => ({
      templateId: 'digest.test.v0',
      templateParams: { lines: group.entries.length },
    }),
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    // The pass runs with the runtime role's grants, not the container superuser's.
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: '-c role=fire_watch_app' });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE alert_digest_log, alert_decision_log, alert_outbox, alert_states, watch_zones,
                channel_subscriptions, accounts, fire_events CASCADE`,
    );
    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    accountId = accounts[0]?.id ?? '';
    const { rows: subscriptions } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
       VALUES ($1, 'push', 'https://example.invalid/push/not-a-real-endpoint') RETURNING id`,
      [accountId],
    );
    subscriptionId = subscriptions[0]?.id ?? '';
  });

  it('runs every pool connection as the runtime role', async () => {
    const { rows } = await pool.query<{ role: string }>('SELECT current_user AS role');
    expect(rows).toEqual([{ role: 'fire_watch_app' }]);
  });

  it('runs a whole cycle as the runtime role, and never re-delivers the window', async () => {
    const z1 = await insertZone();
    const z2 = await insertZone(kmNorth(8));
    const near = await insertEvent(kmNorth(2));
    const far = await insertEvent(kmNorth(5));
    await notify(z1, near.id);
    await notify(z1, far.id);
    await logDefer(z1, near.id, '2026-08-13T20:00:00Z');
    const deps = {
      store: createPgAlertDigestStore(pool),
      cipher,
      routing: routing(),
      clock: new VirtualClock(AT),
      accountPageSize: 10,
    };

    const report = await runAlertDigestCycle(deps);

    expect(report).toMatchObject({
      accountsRead: 1,
      accountsFailed: 0,
      outcomes: { send: 1 },
      candidates: { deferred: 1, active: 1, seeded: 0 },
      linesSent: 2,
      digestsLogged: 2,
      outboxInserted: 1,
    });
    const { rows: log } = await db.query<{ zone: string; outcome: string; entry_count: number }>(
      `SELECT watch_zone_id::text AS zone, outcome, entry_count FROM alert_digest_log
       ORDER BY watch_zone_id`,
    );
    expect(log).toEqual([z1, z2].sort().map((zone) => ({ zone, outcome: 'send', entry_count: 2 })));
    const { rows: outbox } = await db.query<Record<string, unknown>>(
      `SELECT watch_zone_id::text AS zone, fire_event_id::text AS event, alert_type,
              alert_subkey, trigger_type, status, template_params
       FROM alert_outbox`,
    );
    expect(outbox).toEqual([
      {
        zone: z1,
        event: near.id,
        alert_type: 'digest',
        alert_subkey: WINDOW,
        trigger_type: 'digest',
        status: 'pending',
        template_params: { lines: 2 },
      },
    ]);

    const again = await runAlertDigestCycle({ ...deps, clock: new VirtualClock(AT) });
    expect(again).toMatchObject({ outcomes: { none: 1 }, digestsLogged: 0, outboxInserted: 0 });
  });

  it('reads only the digestible pairs of live zones', async () => {
    const zone = await insertZone();
    const deletedZone = await insertZone();
    const good = await insertEvent(kmNorth(1));
    const weakening = await insertEvent(kmNorth(1), { status: 'signal_weakening' });
    const survivor = await insertEvent(kmNorth(1));
    const tombstone = await insertEvent(kmNorth(1), { mergedInto: survivor.id });
    const parent = await insertEvent(kmNorth(1));
    await insertEvent(kmNorth(1), { relatedTo: parent.id });
    const invalid = await insertEvent(kmNorth(1), { invalidated: true });
    const quiet = await insertEvent(kmNorth(1), { status: 'no_longer_detected' });
    const untold = await insertEvent(kmNorth(1));
    for (const event of [good, weakening, tombstone, parent, invalid, quiet]) {
      await notify(zone, event.id);
    }
    await notify(zone, untold.id, 'none');
    await notify(deletedZone, good.id);
    await db.query('UPDATE watch_zones SET deleted_at = now() WHERE id = $1', [deletedZone]);
    await logDefer(zone, good.id, '2026-08-13T20:00:00Z');
    await logDefer(zone, good.id, '2026-08-13T21:00:00Z');

    const pairs = await createPgAlertDigestStore(pool).withAccount(accountId, (tx) =>
      tx.loadPairs(accountId),
    );

    expect(pairs.map((p) => p.eventPublicId).sort()).toEqual(
      [good.publicId, weakening.publicId].sort(),
    );
    const goodPair = pairs.find((p) => p.eventPublicId === good.publicId);
    expect(goodPair).toMatchObject({
      zoneId: zone,
      fireEventId: good.id,
      seededAtIso: null,
      lastNotifiedAtIso: '2026-08-13T10:00:00Z',
      lastDeferredAtIso: '2026-08-13T21:00:00Z',
    });
    expect(goodPair?.centroid.lat).toBeCloseTo(kmNorth(1), 9);
  });

  it('derives the watermark over deleted zones and ignores holds', async () => {
    const zone = await insertZone();
    const gone = await insertZone();
    const store = createPgAlertDigestStore(pool);
    const entry = {
      windowStartIso: WINDOW,
      reason: 'daily_summary' as const,
      outcome: 'send' as const,
      entryCount: 1,
      ruleVersion: 'digest_params_v1',
    };

    const inserted = await store.withAccount(accountId, (tx) =>
      tx.appendLog([
        { ...entry, zoneId: gone, decidedAtIso: '2026-08-14T06:07:00Z' },
        { ...entry, zoneId: zone, decidedAtIso: '2026-08-14T06:09:00Z' },
        {
          ...entry,
          zoneId: zone,
          windowStartIso: '2026-08-15T06:00:00Z',
          outcome: 'hold',
          reason: 'quiet_hours',
          entryCount: 0,
          decidedAtIso: '2026-08-15T06:01:00Z',
        },
      ]),
    );
    const replayed = await store.withAccount(accountId, (tx) =>
      tx.appendLog([{ ...entry, zoneId: zone, decidedAtIso: '2026-08-14T06:30:00Z' }]),
    );
    await db.query('UPDATE watch_zones SET deleted_at = now() WHERE id = $1', [gone]);

    const watermark = await store.withAccount(accountId, (tx) => tx.readWatermark(accountId));

    expect(inserted).toBe(3);
    expect(replayed).toBe(0);
    // The newest spent window, dated by the earliest instant any zone logged it.
    expect(watermark).toEqual({ windowStartIso: WINDOW, decidedAtIso: '2026-08-14T06:07:00Z' });
  });

  it('refuses a row migration 018 forbids, and rolls the whole decision back', async () => {
    const zone = await insertZone();
    const store = createPgAlertDigestStore(pool);

    await expect(
      store.withAccount(accountId, async (tx) => {
        await tx.appendLog([
          {
            zoneId: zone,
            windowStartIso: WINDOW,
            outcome: 'suppress',
            reason: 'nothing_active',
            entryCount: 0,
            ruleVersion: 'digest_params_v1',
            decidedAtIso: AT,
          },
        ]);
        // Decided before the window opened: the CHECK refuses it.
        await tx.appendLog([
          {
            zoneId: zone,
            windowStartIso: WINDOW,
            outcome: 'send',
            reason: 'daily_summary',
            entryCount: 1,
            ruleVersion: 'digest_params_v1',
            decidedAtIso: '2026-08-14T05:59:00Z',
          },
        ]);
      }),
    ).rejects.toThrow(/alert_digest_log_decided_after_window/);

    const { rows } = await db.query('SELECT 1 FROM alert_digest_log');
    expect(rows).toEqual([]);
  });

  it('lists accounts with a live sealed zone, in pages', async () => {
    await insertZone();
    const others: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
      );
      others.push(rows[0]?.id ?? '');
    }
    const [withDeletedZone = '', withNoZone = ''] = others;
    const deleted = await insertZone(CENTRE.lat, withDeletedZone);
    await db.query('UPDATE watch_zones SET deleted_at = now() WHERE id = $1', [deleted]);
    void withNoZone;
    const erased = (
      await db.query<{ id: string }>(
        "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
      )
    ).rows[0]?.id;
    await insertZone(CENTRE.lat, erased);
    await db.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [erased]);
    const store = createPgAlertDigestStore(pool);

    expect(await store.listAccountsAfter(null, 1)).toEqual([accountId]);
    expect(await store.listAccountsAfter(accountId, 1)).toEqual([]);
  });

  it('waits for an erasure holding the account, then finds it tombstoned', async () => {
    await insertZone();
    const store = createPgAlertDigestStore(pool);
    const eraser = new Client({
      connectionString: `${container.getConnectionUri()}?sslmode=disable`,
    });
    await eraser.connect();
    try {
      await eraser.query('BEGIN');
      await eraser.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);

      let settled = false;
      const locked = store
        .withAccount(accountId, (tx) => tx.lockAccount(accountId))
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      await eraser.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [accountId]);
      await eraser.query('COMMIT');

      expect(await locked).toBeNull();
    } finally {
      await eraser.end();
    }
  });

  describe('the retention purge (migration 019)', () => {
    /** One log row, written as the container superuser (the runtime role has no DELETE). */
    async function logRow(
      zoneId: string,
      windowStart: string,
      outcome: 'send' | 'hold' | 'suppress',
      decidedAt: string,
    ): Promise<void> {
      const reason = { send: 'daily_summary', hold: 'quiet_hours', suppress: 'nothing_active' };
      await db.query(
        `INSERT INTO alert_digest_log (
           watch_zone_id, window_start, outcome, reason, entry_count, rule_version, decided_at
         ) VALUES ($1, $2, $3, $4, $5, 'digest_params_v1', $6)`,
        [zoneId, windowStart, outcome, reason[outcome], outcome === 'send' ? 1 : 0, decidedAt],
      );
    }

    async function remaining(): Promise<string[]> {
      const { rows } = await db.query<{ row: string }>(
        `SELECT to_char(window_start AT TIME ZONE 'UTC', 'MM-DD') || ' ' || outcome AS row
         FROM alert_digest_log ORDER BY window_start, outcome, watch_zone_id`,
      );
      return rows.map((r) => r.row);
    }

    const recently = (): string => new Date(Date.now() - 60_000).toISOString();

    it('deletes old windows and keeps the newest spent window and anything after it', async () => {
      const z1 = await insertZone();
      const z2 = await insertZone(kmNorth(8));
      await logRow(z1, '2026-08-10T06:00:00Z', 'send', '2026-08-10T06:05:00Z');
      await logRow(z2, '2026-08-10T06:00:00Z', 'send', '2026-08-10T06:05:00Z');
      await logRow(z1, '2026-08-11T06:00:00Z', 'hold', '2026-08-11T06:01:00Z');
      await logRow(z1, '2026-08-11T06:00:00Z', 'suppress', '2026-08-11T08:00:00Z');
      await logRow(z1, '2026-08-12T06:00:00Z', 'send', '2026-08-12T06:07:00Z');
      await logRow(z2, '2026-08-12T06:00:00Z', 'send', '2026-08-12T06:09:00Z');
      await logRow(z1, '2026-08-13T06:00:00Z', 'hold', '2026-08-13T06:01:00Z');
      const store = createPgAlertDigestStore(pool);
      const before = await store.withAccount(accountId, (tx) => tx.readWatermark(accountId));

      const purged = await createPgErasurePurge(pool).purge('alert_digest_log', recently(), 100);

      expect(purged).toBe(4);
      expect(await remaining()).toEqual(['08-12 send', '08-12 send', '08-13 hold']);
      const after = await store.withAccount(accountId, (tx) => tx.readWatermark(accountId));
      expect(after).toEqual(before);
      expect(after).toEqual({
        windowStartIso: '2026-08-12T06:00:00Z',
        decidedAtIso: '2026-08-12T06:07:00Z',
      });
    });

    it('keeps rows newer than the cutoff, and an account that never spent a window', async () => {
      const zone = await insertZone();
      await logRow(zone, '2026-08-10T06:00:00Z', 'hold', '2026-08-10T06:05:00Z');
      await logRow(zone, '2026-08-11T06:00:00Z', 'hold', '2026-08-11T06:05:00Z');

      expect(await createPgErasurePurge(pool).purge('alert_digest_log', recently(), 100)).toBe(0);

      await logRow(zone, '2026-08-12T06:00:00Z', 'send', '2026-08-12T06:05:00Z');
      // Cutoff before the old holds were decided: nothing is past the retention yet.
      expect(
        await createPgErasurePurge(pool).purge('alert_digest_log', '2026-08-10T06:00:00Z', 100),
      ).toBe(0);
      expect(await remaining()).toEqual(['08-10 hold', '08-11 hold', '08-12 send']);
    });

    it('protects a watermark held only by a soft-deleted zone, per account', async () => {
      const gone = await insertZone();
      const live = await insertZone();
      await logRow(live, '2026-08-10T06:00:00Z', 'send', '2026-08-10T06:05:00Z');
      await logRow(gone, '2026-08-11T06:00:00Z', 'send', '2026-08-11T06:05:00Z');
      await db.query('UPDATE watch_zones SET deleted_at = now() WHERE id = $1', [gone]);
      // Another account, whose newest spent window is older than this account's.
      const { rows } = await db.query<{ id: string }>(
        "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
      );
      const other = await insertZone(CENTRE.lat, rows[0]?.id);
      await logRow(other, '2026-08-09T06:00:00Z', 'suppress', '2026-08-09T06:05:00Z');

      expect(await createPgErasurePurge(pool).purge('alert_digest_log', recently(), 100)).toBe(1);
      expect(await remaining()).toEqual(['08-09 suppress', '08-11 send']);
    });

    it('stops at the row cap, oldest first, and refuses a cutoff in the future', async () => {
      const zone = await insertZone();
      for (const day of ['10', '11', '12', '13']) {
        await logRow(zone, `2026-08-${day}T06:00:00Z`, 'send', `2026-08-${day}T06:05:00Z`);
      }
      const purge = createPgErasurePurge(pool);

      expect(await purge.purge('alert_digest_log', recently(), 2)).toBe(2);
      expect(await remaining()).toEqual(['08-12 send', '08-13 send']);
      await expect(
        purge.purge('alert_digest_log', new Date(Date.now() + 86_400_000).toISOString(), 10),
      ).rejects.toThrow(/cutoff in the past/);
      await expect(pool.query('DELETE FROM alert_digest_log')).rejects.toThrow(/permission denied/);
    });
  });
});
