/**
 * The shadow store and the diff's reader against a real Postgres (TASKS H8; migration 006).
 *
 * What only the database can prove: that a detection set bound as JSON comes back as the
 * sorted array the diff compares; that an event upsert replaces the row but keeps its first
 * sighting; that a replayed alert is a no-op; that a candidate's merge tombstone may be
 * written in the same batch as its survivor (the deferred self-reference); that a deleted
 * zone takes its would-have-been alerts with it; that the reader's window, manual-alert and
 * candidate-scoping rules hold in SQL and not only in the statement text; and that the
 * beta hook cannot return another zone's rows.
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

import type { ShadowAlertRow } from '../../core/ports/shadow-store.js';
import type { ShadowSideEvent } from '../../core/shadow/shadow-diff.js';
import { createPgShadowDiffReader, type PgShadowDiffQueryable } from './pg-shadow-diff-reader.js';
import { createPgShadowStore, type PgShadowStoreQueryable } from './pg-shadow-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The shadow SQL is ' +
      'only ever executed here, so skipping it in CI is a false green.',
  );
}

const CANDIDATE = 'clustering_v2';
const OTHER_CANDIDATE = 'clustering_v3';
const DAY = {
  fromMs: Date.parse('2026-08-20T00:00:00Z'),
  toMs: Date.parse('2026-08-21T00:00:00Z'),
};
const IN_DAY = '2026-08-20T11:29:30.000Z';
const DAY_BEFORE = '2026-08-19T09:00:00.000Z';

const LIVE_IN = 'fw-2026-q7f3d';
const LIVE_QUIET = 'fw-2026-b2k9m';

describe.skipIf(!hasDocker)('the shadow store and reader', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let store: ReturnType<typeof createPgShadowStore>;
  let reader: ReturnType<typeof createPgShadowDiffReader>;

  let accountId: string;
  let zoneId: string;
  let otherZoneId: string;
  let liveQuietId: string;

  function event(overrides: Partial<ShadowSideEvent> = {}): ShadowSideEvent {
    return {
      key: 's-1',
      status: 'active',
      score: 0.82,
      startedAtMs: Date.parse('2026-08-20T02:00:00Z'),
      lastDetectionAtMs: Date.parse('2026-08-20T11:00:00Z'),
      invalidated: false,
      mergedInto: null,
      detectionUids: ['uid-b', 'uid-a'],
      ...overrides,
    };
  }

  function alert(overrides: Partial<ShadowAlertRow> = {}): ShadowAlertRow {
    return {
      zoneId,
      eventKey: 's-1',
      alertType: 'new_fire',
      alertSubkey: 'once',
      templateId: 'new_fire.bg.v3',
      decidedAtMs: Date.parse(IN_DAY),
      ruleVersion: 'alert_gating_v1',
      templateParams: { distance_km: 4 },
      ...overrides,
    };
  }

  const events = (list: readonly ShadowSideEvent[], candidateVersion = CANDIDATE) =>
    store.upsertEvents({ candidateVersion, candidateConfigDigest: 'digest-1', events: list });

  const alerts = (list: readonly ShadowAlertRow[], candidateVersion = CANDIDATE) =>
    store.recordAlerts({ candidateVersion, alerts: list });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;

    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    db = new Client({ connectionString: databaseUrl });
    await db.connect();
    // A `Client` satisfies both declared slices of pg; if either stops type-checking, an
    // adapter grew a dependency on something wider than it says.
    const writer: PgShadowStoreQueryable = db;
    const readerDb: PgShadowDiffQueryable = db;
    store = createPgShadowStore(writer);
    reader = createPgShadowDiffReader(readerDb);

    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    accountId = accounts[0]?.id ?? '';

    // One live event inside the day, one that went quiet the day before.
    const { rows: live } = await db.query<{ id: string; public_id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at,
         centroid, score, config_version, source_registry_version
       )
       VALUES ($1, 'active', $3, $3, $3,
               ST_SetSRID(ST_MakePoint(23.30, 42.60), 4326), 0.82,
               'clustering_v1', 'source_registry_v1'),
              ($2, 'signal_weakening', $4, $4, $4,
               ST_SetSRID(ST_MakePoint(23.57, 42.15), 4326), 0.61,
               'clustering_v1', 'source_registry_v1')
       RETURNING id::text, public_id`,
      [LIVE_IN, LIVE_QUIET, IN_DAY, DAY_BEFORE],
    );
    liveQuietId = live.find((row) => row.public_id === LIVE_QUIET)?.id ?? '';
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM alert_outbox');
    await db.query('DELETE FROM alerts_shadow');
    await db.query('DELETE FROM events_shadow');
    await db.query('DELETE FROM watch_zones');
    const { rows: zones } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Vitosha', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000),
              ($1, 'Rila',    ST_GeogFromText('SRID=4326;POINT(23.55 42.13)'), 5000)
       RETURNING id`,
      [accountId],
    );
    zoneId = zones[0]?.id ?? '';
    otherZoneId = zones[1]?.id ?? '';
  });

  describe('events_shadow', () => {
    it('stores the detection set sorted and reads it back unchanged', async () => {
      expect(await events([event()])).toBe(1);

      const { shadow } = await reader.loadWindow({ candidateVersion: CANDIDATE, window: DAY });
      expect(shadow.events).toEqual([
        { ...event(), score: shadow.events[0]?.score, detectionUids: ['uid-a', 'uid-b'] },
      ]);
      // `real` on both sides: 0.82 comes back as its float4 widening, not as 0.82.
      expect(shadow.events[0]?.score).toBeCloseTo(0.82, 6);
    });

    it('replaces the row on a re-derived tick but keeps the first sighting', async () => {
      await events([event()]);
      const { rows: before } = await db.query<{ recorded_at: Date }>(
        'SELECT recorded_at FROM events_shadow',
      );
      await events([event({ status: 'signal_weakening', detectionUids: ['uid-c'] })]);

      const { rows } = await db.query<{
        status: string;
        detection_uids: string[];
        recorded_at: Date;
        updated_at: Date;
      }>('SELECT status, detection_uids, recorded_at, updated_at FROM events_shadow');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'signal_weakening', detection_uids: ['uid-c'] });
      expect(rows[0]?.recorded_at.getTime()).toBe(before[0]?.recorded_at.getTime());
    });

    it('takes a merge tombstone in the same batch as its survivor', async () => {
      await events([
        event({ key: 's-dead', mergedInto: 's-1', detectionUids: ['uid-z'] }),
        event(),
      ]);
      const { shadow } = await reader.loadWindow({ candidateVersion: CANDIDATE, window: DAY });
      expect(shadow.events.find((e) => e.key === 's-dead')?.mergedInto).toBe('s-1');
    });

    it('refuses a tombstone whose survivor the candidate never wrote', async () => {
      await expect(events([event({ mergedInto: 's-missing' })])).rejects.toThrow(/foreign key/);
    });

    it('keeps candidates apart', async () => {
      await events([event()]);
      await events([event({ key: 's-other' })], OTHER_CANDIDATE);

      const { shadow } = await reader.loadWindow({ candidateVersion: CANDIDATE, window: DAY });
      expect(shadow.events.map((e) => e.key)).toEqual(['s-1']);
    });
  });

  describe('alerts_shadow', () => {
    it('is append-only: a replayed alert writes nothing', async () => {
      await events([event()]);
      expect(await alerts([alert()])).toBe(1);
      expect(await alerts([alert({ templateId: 'changed' })])).toBe(0);

      const { rows } = await db.query<{ template_id: string; trigger_type: string }>(
        'SELECT template_id, trigger_type FROM alerts_shadow',
      );
      expect(rows).toEqual([{ template_id: 'new_fire.bg.v3', trigger_type: 'new_fire' }]);
    });

    it('goes with the zone', async () => {
      await events([event()]);
      await alerts([alert()]);
      await db.query('DELETE FROM watch_zones WHERE id = $1', [zoneId]);

      const { rows } = await db.query('SELECT 1 FROM alerts_shadow');
      expect(rows).toEqual([]);
    });

    it('pulls a quiet shadow event into the window through its in-window alert', async () => {
      await events([
        event({
          startedAtMs: Date.parse(DAY_BEFORE),
          lastDetectionAtMs: Date.parse(DAY_BEFORE),
        }),
      ]);
      await alerts([alert()]);

      const { shadow } = await reader.loadWindow({ candidateVersion: CANDIDATE, window: DAY });
      expect(shadow.events.map((e) => e.key)).toEqual(['s-1']);
      expect(shadow.alerts.map((a) => a.eventKey)).toEqual(['s-1']);
    });
  });

  describe('the live side', () => {
    async function outbox(eventId: string, triggerType: string, subkey: string): Promise<void> {
      await db.query(
        `INSERT INTO alert_outbox (
           watch_zone_id, fire_event_id, alert_type, alert_subkey, trigger_type,
           trigger_ref_seq, rule_version, template_id, channel, status, decided_at
         ) VALUES ($1, $2, 'new_fire', $4, $3, 1, 'alert_gating_v1',
                   'new_fire.bg.v3', 'push', 'pending', $5)`,
        [zoneId, eventId, triggerType, subkey, IN_DAY],
      );
    }

    it('reads in-window events by public id, with an empty set where nothing is promoted', async () => {
      const { live } = await reader.loadWindow({ candidateVersion: CANDIDATE, window: DAY });
      expect(live.events.map((e) => [e.key, e.detectionUids])).toEqual([[LIVE_IN, []]]);
    });

    it('follows an automatic alert to a quiet event, and ignores a manual one', async () => {
      await outbox(liveQuietId, 'new_fire', 'once');
      let sides = await reader.loadWindow({ candidateVersion: CANDIDATE, window: DAY });
      expect(sides.live.events.map((e) => e.key).sort()).toEqual([LIVE_QUIET, LIVE_IN].sort());
      expect(sides.live.alerts.map((a) => a.eventKey)).toEqual([LIVE_QUIET]);

      await db.query('DELETE FROM alert_outbox');
      await outbox(liveQuietId, 'manual', 'manual-1');
      sides = await reader.loadWindow({ candidateVersion: CANDIDATE, window: DAY });
      expect(sides.live.events.map((e) => e.key)).toEqual([LIVE_IN]);
      expect(sides.live.alerts).toEqual([]);
    });
  });

  describe('the beta hook', () => {
    it("returns one zone's shadow alerts, oldest first, and never another zone's", async () => {
      await events([event()]);
      await alerts([
        alert({
          alertType: 'escalation',
          alertSubkey: '1',
          decidedAtMs: Date.parse(IN_DAY) + 60_000,
        }),
        alert(),
        alert({ zoneId: otherZoneId }),
      ]);

      const mine = await reader.shadowAlertsForZone({
        zoneId,
        candidateVersion: CANDIDATE,
        window: DAY,
      });
      expect(mine.map((a) => [a.zoneId, a.alertType])).toEqual([
        [zoneId, 'new_fire'],
        [zoneId, 'escalation'],
      ]);
    });
  });
});
