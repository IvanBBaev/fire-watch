/**
 * The digest store's SQL against a real PostGIS (TASKS H3; migration 018): what
 * `loadPairs` lets through, how the watermark is derived, that a replayed log insert is
 * a no-op, that erasure wins the account lock, and a whole cycle — including two passes
 * racing on one account — through the real core.
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
import { VirtualClock, epochMsFromIso } from '../../core/ports/clock.js';
import type { AlertDigestRouting } from '../../core/ports/alert-digest-routing.js';
import type { DigestLogEntry } from '../../core/ports/alert-digest-store.js';
import { ZONE_GRID, indexCellKey } from '../../core/zones/zone-geometry.js';
import { createAesGcmZoneCipher } from '../crypto/aes-gcm-zone-cipher.js';
import { createPgAlertDigestStore } from './pg-alert-digest-store.js';
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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The digest store SQL ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

// Sofia is UTC+3 in August: the 09:00 local window opens at 06:00Z.
const WINDOW = '2026-08-14T06:00:00Z';
const AFTERNOON = '2026-08-14T12:00:00.000Z';
const CENTRE = { lat: 42.6, lon: 23.3 };
const kmNorth = (km: number): number => CENTRE.lat + km / ZONE_MATCH_METRIC.kmPerDegreeLat;

const cipher = createAesGcmZoneCipher({
  active: { id: 'test-key', key: new Uint8Array(32).fill(7) },
  retired: [],
});

describe.skipIf(!hasDocker)('the digest store adapter', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let subscriptionId = '';

  async function insertAccount(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    return rows[0]?.id ?? '';
  }

  async function insertZone(accountId: string, createdAtIso = '2026-08-01T00:00:00Z') {
    const id = randomUUID();
    await createPgWatchZoneStore(db).insert({
      id,
      accountId,
      name: 'Vitosha',
      radiusM: 10_000,
      minScore: 0.45,
      sealed: cipher.seal(id, CENTRE),
      coarsened: false,
      gridVersion: ZONE_GRID.version,
      gridCell: indexCellKey(CENTRE, ZONE_GRID.values),
      createdAtIso,
    });
    return id;
  }

  async function insertEvent(
    publicId: string,
    fields: {
      status?: string;
      invalidated?: boolean;
      mergedInto?: string;
      relatedTo?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid, score,
         invalidated, config_version, source_registry_version, merged_into, related_event_id,
         relation_kind, inactive_since
       ) VALUES ($1, $2, $3, $3, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), 0.9, $6,
                 'clustering_v1', 'source_registry_v1', $7, $8,
                 CASE WHEN $8::bigint IS NULL THEN NULL ELSE 'possible_reignition' END,
                 -- Migration 004: the inactivity anchor exists exactly while not active.
                 CASE WHEN $2 IN ('active', 'signal_weakening') THEN NULL ELSE $3::timestamptz END)
       RETURNING id::text AS id`,
      [
        publicId,
        fields.status ?? 'active',
        '2026-08-13T10:00:00Z',
        CENTRE.lon,
        kmNorth(2),
        fields.invalidated ?? false,
        fields.mergedInto ?? null,
        fields.relatedTo ?? null,
      ],
    );
    return rows[0]?.id ?? '';
  }

  async function notify(
    zoneId: string,
    eventId: string,
    state = 'notified_new',
    seededAt: string | null = null,
  ): Promise<void> {
    await db.query(
      `INSERT INTO alert_states (watch_zone_id, fire_event_id, state, seeded_at, last_notified_at)
       VALUES ($1, $2, $3, $4, '2026-08-13T10:00:00Z')`,
      [zoneId, eventId, state, seededAt],
    );
  }

  async function logDecision(
    zoneId: string,
    eventId: string,
    seq: number,
    decision: { pass: string; outcome: string; decidedAt: string },
  ): Promise<void> {
    const deferred = decision.outcome === 'defer';
    await db.query(
      `INSERT INTO alert_decision_log (
         watch_zone_id, fire_event_id, trigger_ref_seq, pass, outcome, reason, code,
         alert_type, ladder_step, in_quiet_hours, rule_version, decided_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, false, 'alert_gating_v1', $9)`,
      [
        zoneId,
        eventId,
        seq,
        decision.pass,
        decision.outcome,
        deferred ? 'quiet_hours' : 'below_zone_threshold',
        deferred ? 'deferred_quiet_hours' : 'suppressed_below_zone_threshold',
        deferred ? 'new_fire' : null,
        decision.decidedAt,
      ],
    );
  }

  function logEntry(zoneId: string, overrides: Partial<DigestLogEntry> = {}): DigestLogEntry {
    return {
      zoneId,
      windowStartIso: WINDOW,
      outcome: 'suppress',
      reason: 'nothing_active',
      entryCount: 0,
      ruleVersion: 'digest_params_v1',
      decidedAtIso: '2026-08-14T06:05:00Z',
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
    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
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
  });

  const routing = (): AlertDigestRouting => ({
    targetFor: () => Promise.resolve({ channel: 'push', channelSubscriptionId: subscriptionId }),
    digestCopyFor: () => ({ templateId: 'digest.test.v0', templateParams: {} }),
  });

  async function subscribe(accountId: string): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
       VALUES ($1, 'push', 'https://example.invalid/push/not-a-real-endpoint') RETURNING id`,
      [accountId],
    );
    subscriptionId = rows[0]?.id ?? '';
  }

  it('lists live accounts with a live sealed zone, in id order, a page at a time', async () => {
    const withZone = [await insertAccount(), await insertAccount(), await insertAccount()];
    for (const id of withZone) await insertZone(id);
    await insertAccount(); // no zone at all
    const deletedZone = await insertAccount();
    const gone = await insertZone(deletedZone);
    await db.query('UPDATE watch_zones SET deleted_at = now() WHERE id = $1', [gone]);
    const store = createPgAlertDigestStore(pool);

    const sorted = [...withZone].sort();
    const first = await store.listAccountsAfter(null, 2);
    expect(first).toEqual(sorted.slice(0, 2));
    expect(await store.listAccountsAfter(first[1] ?? null, 2)).toEqual(sorted.slice(2));
  });

  it('locks the account and reads its settings as HH:MM, or nothing once it is tombstoned', async () => {
    const accountId = await insertAccount();
    const store = createPgAlertDigestStore(pool);

    expect(await store.withAccount(accountId, (tx) => tx.lockAccount(accountId))).toEqual({
      timezone: 'Europe/Sofia',
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      newFireOverridesQuietHours: true,
    });
    await db.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [accountId]);
    expect(await store.withAccount(accountId, (tx) => tx.lockAccount(accountId))).toBe(null);
  });

  it('makes a running erasure win: the pass waits, then finds the tombstone', async () => {
    const accountId = await insertAccount();
    const eraser = await pool.connect();
    try {
      await eraser.query('BEGIN');
      await eraser.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      const store = createPgAlertDigestStore(pool);
      const locked = store.withAccount(accountId, (tx) => tx.lockAccount(accountId));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await eraser.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [accountId]);
      await eraser.query('COMMIT');
      expect(await locked).toBe(null);
    } finally {
      eraser.release();
    }
  });

  it('loads exactly the digestible pairs, with the newest evaluation defer', async () => {
    const accountId = await insertAccount();
    const zone = await insertZone(accountId);
    const deletedZone = await insertZone(accountId);

    const live = await insertEvent('fw-2026-aaaaa');
    const weakening = await insertEvent('fw-2026-bbbbb', { status: 'signal_weakening' });
    const quiet = await insertEvent('fw-2026-ccccc'); // state 'none'
    const closed = await insertEvent('fw-2026-ddddd', { status: 'no_longer_detected' });
    const invalid = await insertEvent('fw-2026-eeeee', { invalidated: true });
    const merged = await insertEvent('fw-2026-fffff', { mergedInto: live });
    const parent = await insertEvent('fw-2026-ggggg');
    await insertEvent('fw-2026-hhhhh', { relatedTo: parent });
    const onDeletedZone = await insertEvent('fw-2026-iiiii');

    await notify(zone, live);
    await notify(zone, weakening, 'notified_escalation', '2026-08-12T08:00:00Z');
    await notify(zone, quiet, 'none');
    for (const id of [closed, invalid, merged, parent]) await notify(zone, id);
    await notify(deletedZone, onDeletedZone);
    await db.query('UPDATE watch_zones SET deleted_at = now() WHERE id = $1', [deletedZone]);

    await logDecision(zone, live, 1, {
      pass: 'evaluation',
      outcome: 'defer',
      decidedAt: '2026-08-13T20:00:00Z',
    });
    await logDecision(zone, live, 2, {
      pass: 'evaluation',
      outcome: 'defer',
      decidedAt: '2026-08-13T23:00:00Z',
    });
    await logDecision(zone, live, 3, {
      pass: 'evaluation',
      outcome: 'suppress',
      decidedAt: '2026-08-14T01:00:00Z',
    });

    const pairs = await createPgAlertDigestStore(pool).withAccount(accountId, (tx) =>
      tx.loadPairs(accountId),
    );

    expect(pairs.map((p) => p.eventPublicId)).toEqual(['fw-2026-aaaaa', 'fw-2026-bbbbb']);
    const [first, second] = pairs;
    expect(first).toMatchObject({
      zoneId: zone,
      fireEventId: live,
      lastDeferredAtIso: '2026-08-13T23:00:00Z',
      seededAtIso: null,
      lastNotifiedAtIso: '2026-08-13T10:00:00Z',
    });
    expect(first?.seq).toMatch(/^\d+$/);
    expect(first?.centroid.lat).toBeCloseTo(kmNorth(2), 9);
    expect(first?.centroid.lon).toBeCloseTo(CENTRE.lon, 9);
    expect(second).toMatchObject({ seededAtIso: '2026-08-12T08:00:00Z', lastDeferredAtIso: null });
  });

  it('appends each (zone, window, outcome) once and reports only what went in', async () => {
    const accountId = await insertAccount();
    const z1 = await insertZone(accountId);
    const z2 = await insertZone(accountId);
    const store = createPgAlertDigestStore(pool);
    const append = (entries: readonly DigestLogEntry[]): Promise<number> =>
      store.withAccount(accountId, (tx) => tx.appendLog(entries));

    expect(await append([logEntry(z1)])).toBe(1);
    expect(await append([logEntry(z1), logEntry(z2)])).toBe(1);
    expect(await append([logEntry(z1, { outcome: 'hold', reason: 'quiet_hours' })])).toBe(1);
    expect(await append([])).toBe(0);
    await expect(
      append([logEntry(z1, { outcome: 'send', reason: 'daily_summary' })]),
    ).rejects.toThrow(/alert_digest_log_reason_matches_outcome/);
  });

  it('derives the watermark from spent windows only, soft-deleted zones included', async () => {
    const accountId = await insertAccount();
    const z1 = await insertZone(accountId);
    const z2 = await insertZone(accountId);
    const store = createPgAlertDigestStore(pool);
    const watermark = () => store.withAccount(accountId, (tx) => tx.readWatermark(accountId));
    const append = (entries: readonly DigestLogEntry[]) =>
      store.withAccount(accountId, (tx) => tx.appendLog(entries));

    expect(await watermark()).toBe(null);
    await append([
      logEntry(z1, {
        windowStartIso: '2026-08-13T06:00:00Z',
        decidedAtIso: '2026-08-13T06:01:00Z',
      }),
    ]);
    // A hold on a later window never moves it.
    await append([logEntry(z1, { outcome: 'hold', reason: 'quiet_hours' })]);
    expect(await watermark()).toEqual({
      windowStartIso: '2026-08-13T06:00:00Z',
      decidedAtIso: '2026-08-13T06:01:00Z',
    });

    // The later window, spent on a zone the reader then deleted: still spent. Two
    // instants on one window read as the earlier.
    await append([
      logEntry(z1, { decidedAtIso: '2026-08-14T15:00:00Z' }),
      logEntry(z2, { decidedAtIso: '2026-08-14T14:00:00Z' }),
    ]);
    await db.query('UPDATE watch_zones SET deleted_at = now() WHERE id = $1', [z2]);
    // 14:00 is on the deleted zone and is the earlier instant: reading it proves both that
    // soft-deleted zones count and that the earliest instant wins.
    expect(await watermark()).toEqual({
      windowStartIso: WINDOW,
      decidedAtIso: '2026-08-14T14:00:00Z',
    });
    // And the deleted zone alone still keeps the window spent.
    await db.query('DELETE FROM alert_digest_log WHERE watch_zone_id = $1', [z1]);
    expect((await watermark())?.windowStartIso).toBe(WINDOW);
  });

  it('runs a whole cycle: one digest row in the outbox, and the window is never re-offered', async () => {
    const accountId = await insertAccount();
    await subscribe(accountId);
    const zone = await insertZone(accountId);
    const event = await insertEvent('fw-2026-aaaaa');
    await notify(zone, event);
    const deps = (at: string) => ({
      store: createPgAlertDigestStore(pool),
      cipher,
      routing: routing(),
      clock: new VirtualClock(epochMsFromIso(at)),
      accountPageSize: 10,
    });

    const report = await runAlertDigestCycle(deps(AFTERNOON));
    expect(report).toMatchObject({ accountsFailed: 0, linesSent: 1, outboxInserted: 1 });

    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT watch_zone_id::text AS zone, fire_event_id::text AS event, alert_type, alert_subkey
       FROM alert_outbox`,
    );
    expect(rows).toEqual([{ zone, event, alert_type: 'digest', alert_subkey: WINDOW }]);

    const again = await runAlertDigestCycle(deps('2026-08-14T13:00:00.000Z'));
    expect(again.outcomes.none).toBe(1);
    const { rows: count } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM alert_outbox',
    );
    expect(count[0]?.n).toBe(1);
  });

  it('lets only the first of two racing passes log a window; the second inserts nothing', async () => {
    const accountId = await insertAccount();
    const zone = await insertZone(accountId);
    const store = createPgAlertDigestStore(pool);
    const send = [logEntry(zone, { outcome: 'send', reason: 'daily_summary', entryCount: 1 })];

    // Both passes hold the account FOR SHARE (compatible) and read the same, empty,
    // watermark before either writes — the interleaving the unique constraint exists for.
    let releaseA: () => void = () => undefined;
    const aMayWrite = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let bHasRead: () => void = () => undefined;
    const bRead = new Promise<void>((resolve) => {
      bHasRead = resolve;
    });

    const a = store.withAccount(accountId, async (tx) => {
      await tx.lockAccount(accountId);
      const seen = await tx.readWatermark(accountId);
      await aMayWrite;
      return { seen, inserted: await tx.appendLog(send) };
    });
    const b = store.withAccount(accountId, async (tx) => {
      await tx.lockAccount(accountId);
      const seen = await tx.readWatermark(accountId);
      bHasRead();
      // B's insert blocks on A's uncommitted row until A commits, then does nothing.
      return { seen, inserted: await tx.appendLog(send) };
    });
    await bRead;
    releaseA();

    const [first, second] = await Promise.all([a, b]);
    expect(first).toEqual({ seen: null, inserted: 1 });
    expect(second).toEqual({ seen: null, inserted: 0 });
  });

  it('delivers once when two whole cycles run at the same instant', async () => {
    const accountId = await insertAccount();
    await subscribe(accountId);
    const zone = await insertZone(accountId);
    await notify(zone, await insertEvent('fw-2026-aaaaa'));
    const deps = () => ({
      store: createPgAlertDigestStore(pool),
      cipher,
      routing: routing(),
      clock: new VirtualClock(epochMsFromIso(AFTERNOON)),
      accountPageSize: 10,
    });

    const [a, b] = await Promise.all([runAlertDigestCycle(deps()), runAlertDigestCycle(deps())]);

    expect(a.outboxInserted + b.outboxInserted).toBe(1);
    expect(a.accountsFailed + b.accountsFailed).toBe(0);
    const { rows } = await db.query<{ outbox: number; log: number }>(
      `SELECT (SELECT count(*)::int FROM alert_outbox) AS outbox,
              (SELECT count(*)::int FROM alert_digest_log) AS log`,
    );
    expect(rows[0]).toEqual({ outbox: 1, log: 1 });
  });
});
