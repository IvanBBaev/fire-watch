/**
 * The weekly QA report store and its input reader against a real Postgres (TASKS D8;
 * migration 011).
 *
 * What only the database can prove: that the PLB reader's `available_at` window and SP
 * exclusion hold in SQL, and that its first-attachment proxy reads live runs only; that the
 * DAR reader resolves a merged event to its survivor, drops manual rows and keeps its
 * `decided_at` window; that a stored report round-trips and a digest changed under the
 * same versions is refused; and that migration 011's CHECKs reject the rows the job never
 * writes (an open week, a window that is not a Monday-aligned ISO week, a mislabelled one).
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { StoredWeeklyReport } from '../../core/ports/qa-report-store.js';
import { isoWeekWindow } from '../../core/qa/iso-week.js';
import { runWeeklyQaReport } from '../../core/qa/weekly-report-job.js';
import { createPgQaReportStore, type PgQaReportQueryable } from './pg-qa-report-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The QA report SQL ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const W38 = isoWeekWindow('2026-W38');
const at = (hoursIntoWeek: number): string =>
  new Date(W38.fromMs + hoursIntoWeek * 3_600_000).toISOString();
const uid = (n: number): string => n.toString(16).padStart(64, '0');

describe.skipIf(!hasDocker)('the weekly QA report store and reader', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let store: ReturnType<typeof createPgQaReportStore>;
  let zoneId = '';

  async function insertDetection(n: number, availableAt: string, tier = 'NRT'): Promise<string> {
    await db.query(
      `INSERT INTO detections (
         detection_uid, source, product_tier, acq_ts, available_at, lat, lon,
         confidence_raw, confidence, source_registry_version, ingest_config_version, ingested_at
       ) VALUES ($1, 'firms:viirs:snpp', $2, $3, $3, 42.6, 25.1, 'n', 'nominal', $4, 'ingest_v1',
                 $3::timestamptz + interval '1 minute')`,
      [uid(n), tier, availableAt, SOURCE_REGISTRY_VERSION],
    );
    return uid(n);
  }

  async function insertEvent(publicId: string, mergedInto: string | null = null): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at,
         centroid, score, config_version, source_registry_version, merged_into
       ) VALUES ($1, 'active', $2, $2, $2, ST_SetSRID(ST_MakePoint(23.30, 42.60), 4326), 0.8,
                 'clustering_v1', 'source_registry_v1', $3)
       RETURNING id::text AS id`,
      [publicId, at(0), mergedInto],
    );
    return rows[0]?.id ?? '';
  }

  async function insertRun(kind: 'live' | 'offline'): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO clustering_runs (kind, config_version, config_digest)
       VALUES ($1, 'clustering_v1', 'abcd1234') RETURNING id::text AS id`,
      [kind],
    );
    return rows[0]?.id ?? '';
  }

  async function attach(runId: string, eventId: string, n: number, attachedAt: string) {
    const { rows } = await db.query<{ acq_ts: Date }>(
      'SELECT acq_ts FROM detections WHERE detection_uid = $1',
      [uid(n)],
    );
    await db.query(
      `INSERT INTO event_detections (clustering_run_id, fire_event_id, detection_uid, acq_ts, attached_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, eventId, uid(n), rows[0]?.acq_ts, attachedAt],
    );
  }

  async function outbox(
    eventId: string,
    decidedAt: string,
    fields: { trigger?: string; subkey?: string; channel?: string } = {},
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO alert_outbox (
         watch_zone_id, fire_event_id, alert_type, alert_subkey, trigger_type,
         trigger_ref_seq, rule_version, template_id, channel, status, decided_at
       ) VALUES ($1, $2, 'new_fire', $3, $4, 1, 'alert_gating_v1', 'new_fire.bg.v3', $5,
                 'pending', $6)
       RETURNING id::text AS id`,
      [
        zoneId,
        eventId,
        fields.subkey ?? 'once',
        fields.trigger ?? 'new_fire',
        fields.channel ?? 'push',
        decidedAt,
      ],
    );
    return rows[0]?.id ?? '';
  }

  function stored(overrides: Partial<StoredWeeklyReport> = {}): StoredWeeklyReport {
    return {
      isoWeek: '2026-W38',
      fromMs: W38.fromMs,
      toMs: W38.toMs,
      metricsVersion: 'qa_metrics_v1',
      metricsDigest: '43e53e7c',
      reportVersion: 'qa_weekly_report_v1',
      reportDigest: '8cae3b34',
      generatedAtMs: W38.toMs + 60_000,
      reportJson: '{"kind":"fire_watch_qa_weekly_report","n":1}',
      reportMarkdown: '# report\n',
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
    // A `Client` satisfies the declared slice of pg; if it stops type-checking, the
    // adapter grew a dependency on something wider than it says.
    const storeDb: PgQaReportQueryable = db;
    store = createPgQaReportStore(storeDb);
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM qa_weekly_reports');
    await db.query('DELETE FROM alert_outbox');
    await db.query('DELETE FROM event_detections');
    await db.query('DELETE FROM clustering_runs');
    await db.query('UPDATE fire_events SET merged_into = NULL');
    await db.query('DELETE FROM fire_events');
    await db.query('DELETE FROM watch_zones');
    await db.query('DELETE FROM accounts');
    await db.query('DELETE FROM detections');

    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    const { rows: zones } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Vitosha', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000)
       RETURNING id`,
      [accounts[0]?.id],
    );
    zoneId = zones[0]?.id ?? '';
  });

  describe('loadPlbTraces', () => {
    it('reads the window by arrival, SP excluded, attached by live runs only', async () => {
      const live = await insertRun('live');
      const laterLive = await insertRun('live');
      const offline = await insertRun('offline');
      const event = await insertEvent('fw-2026-aaaaa');

      await insertDetection(1, at(1));
      await insertDetection(2, at(2));
      await insertDetection(3, at(3), 'SP');
      await insertDetection(4, at(-1)); // before the window
      await insertDetection(5, at(7 * 24)); // at its exclusive end

      await attach(live, event, 1, at(1.2));
      await attach(laterLive, event, 1, at(1.1)); // the earliest live attachment wins
      await attach(offline, event, 2, at(2.05)); // offline attachments are not the live path

      const traces = await store.loadPlbTraces(W38);
      expect(traces.map((t) => t.traceId)).toEqual([uid(1), uid(2)]);
      expect(traces[0]?.eventUpdatedAtMs).toBe(Date.parse(at(1.1)));
      expect(traces[1]?.eventUpdatedAtMs).toBeNull();
      expect(traces[0]?.availableAtMs).toBe(Date.parse(at(1)));
      expect(traces[0]?.ingestedAtMs).toBe(Date.parse(at(1)) + 60_000);
    });
  });

  describe('loadDarAlerts', () => {
    it('resolves merged events to the survivor and drops manual rows', async () => {
      const survivor = await insertEvent('fw-2026-surv1');
      const middle = await insertEvent('fw-2026-midd1', survivor);
      const loser = await insertEvent('fw-2026-lose1', middle);

      const a = await outbox(loser, at(1));
      const b = await outbox(survivor, at(2), { subkey: 'again' });
      await outbox(survivor, at(3), { trigger: 'manual', subkey: 'manual-1' });
      await outbox(survivor, at(-1), { subkey: 'before' });

      const alerts = await store.loadDarAlerts(W38);
      expect(alerts.map((x) => [x.alertId, x.eventKey, x.zoneId])).toEqual([
        [a, 'fw-2026-surv1', zoneId],
        [b, 'fw-2026-surv1', zoneId],
      ]);
      expect(alerts[0]?.decidedAtMs).toBe(Date.parse(at(1)));
    });

    it('refuses a merge cycle rather than keying it arbitrarily', async () => {
      const one = await insertEvent('fw-2026-cyc01');
      const two = await insertEvent('fw-2026-cyc02', one);
      await db.query('UPDATE fire_events SET merged_into = $1 WHERE id = $2', [two, one]);
      await outbox(one, at(1));
      await expect(store.loadDarAlerts(W38)).rejects.toThrow(/merge chain/);
    });
  });

  describe('qa_weekly_reports', () => {
    it('round-trips has/save and replaces a row under the same digests', async () => {
      const key = {
        isoWeek: '2026-W38',
        metricsVersion: 'qa_metrics_v1',
        reportVersion: 'qa_weekly_report_v1',
      };
      expect(await store.has(key)).toBe(false);
      await store.save(stored());
      expect(await store.has(key)).toBe(true);
      await store.save(stored({ reportMarkdown: '# rebuilt\n' }));

      const { rows } = await db.query<{ report_markdown: string; report_json: string }>(
        'SELECT report_markdown, report_json FROM qa_weekly_reports',
      );
      expect(rows).toEqual([{ report_markdown: '# rebuilt\n', report_json: stored().reportJson }]);
    });

    it('refuses a different digest under the same versions', async () => {
      await store.save(stored());
      await expect(store.save(stored({ reportDigest: 'edited00' }))).rejects.toThrow(
        /different digest/,
      );
      await expect(store.save(stored({ metricsDigest: 'edited00' }))).rejects.toThrow(
        /different digest/,
      );
    });

    it.each([
      ['an open week', { generatedAtMs: W38.toMs - 1 }],
      ['a window not on Monday', { fromMs: W38.fromMs + 86_400_000, toMs: W38.toMs + 86_400_000 }],
      ['a window that is not seven days', { toMs: W38.toMs - 1 }],
      ['a label that does not match', { isoWeek: '2026-W37' }],
      ['JSON of another kind', { reportJson: '{"kind":"other"}' }],
    ])('rejects %s', async (_label, overrides) => {
      await expect(store.save(stored(overrides))).rejects.toThrow(/check constraint/);
    });
  });

  it('runs the job end to end and stores the last closed week once', async () => {
    const live = await insertRun('live');
    const event = await insertEvent('fw-2026-e2e01');
    await insertDetection(1, at(1));
    await attach(live, event, 1, at(1.1));
    await outbox(event, at(2));
    await outbox(event, at(3), { subkey: 'repeat' });

    const deps = {
      reader: store,
      store,
      clock: new VirtualClock(Date.parse('2026-09-23T10:00:00Z')),
      pollIntervalMs: 600_000,
    };
    const first = await runWeeklyQaReport(deps);
    expect(first.outcome === 'built' && first.persisted).toBe(true);
    if (first.outcome === 'built') {
      expect(first.report.metrics.shadowPlb.traces).toBe(1);
      expect(first.report.metrics.dar.rate.denominator).toBe(2);
    }
    expect(await runWeeklyQaReport(deps)).toMatchObject({ outcome: 'skipped' });

    const { rows } = await db.query<{ report_json: string }>(
      'SELECT report_json FROM qa_weekly_reports',
    );
    expect(first.outcome === 'built' && rows[0]?.report_json === first.json).toBe(true);
  });
});
