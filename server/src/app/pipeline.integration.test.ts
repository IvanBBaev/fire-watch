/**
 * The worker's production chain end to end against a real Postgres: FIRMS ingest into the
 * detection store, the identity cycle (clustering, identity, lifecycle tick), the snapshot
 * read and build the API serves, and the live alert evaluation that feeds the outbox.
 *
 * Every stage runs through the code the worker composes — `wireIngest` and `wireIdentity`
 * over their own pools as the runtime role — with exactly two substitutions: the FIRMS
 * HTTP client is replaced by one that serves the `harness-smoke` fixture as the CSV the
 * Area API would return, and the system clock by a virtual one. Running as
 * `fire_watch_app` is the point: a GRANT a migration forgot is invisible to every adapter
 * test that connects as the container superuser, and fatal in production.
 *
 * What only this test shows:
 *   - the uid ingest mints equals the fixture's, so the archive and the replay agree on
 *     identity;
 *   - a re-poll (the day_range=2 overlap) and a re-run of the identity cycle are no-ops —
 *     `seq` does not move and no event is minted twice;
 *   - a later poll extends the event it belongs to instead of seeding a duplicate;
 *   - the snapshot document carries valid public ids and a `max_seq` that follows every
 *     write, and a lifecycle transition reaches it;
 *   - the identity cycle persists the v0 score, and alert evaluation reads the events the
 *     pipeline wrote and alerts on the one above the zone's threshold.
 *
 * Founder-decision inputs stay at the repo's unarmed defaults: no cloud field, no
 * declarations, no outages; the alert cadence and routing are unratified, so the alert
 * stage is composed by hand exactly as `pg-alert-evaluation-store.integration.test.ts`
 * does, with a test keyring and a test route.
 *
 * Skipped when there is no Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that
 * skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { scoreBucket } from '@fire-watch/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAesGcmZoneCipher } from '../adapters/crypto/aes-gcm-zone-cipher.js';
import { createPgAlertEvaluationStore } from '../adapters/db/pg-alert-evaluation-store.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgSnapshotReader } from '../adapters/db/pg-snapshot-reader.js';
import { createPgWatchZoneStore } from '../adapters/db/pg-watch-zone-store.js';
import { loadFixture } from '../adapters/fixtures/fixture-loader.js';
import { runAlertEvaluationCycle } from '../core/alerts/evaluation-cycle.js';
import { runIdentityCycle, type IdentityCycleReport } from '../core/identity/identity-cycle.js';
import { runIngestCycle, type IngestCycleReport } from '../core/ingest/ingest-cycle.js';
import type { AlertRouting } from '../core/ports/alert-routing.js';
import { VirtualClock, epochMsFromIso } from '../core/ports/clock.js';
import type { FirmsAreaClient, FirmsAreaQuery } from '../core/ports/firms-client.js';
import type { ReplayBatchInput, ReplayDetectionInput } from '../core/replay/fixture-format.js';
import {
  buildSnapshot,
  snapshotEtag,
  type SnapshotDocument,
} from '../core/snapshot/snapshot-builder.js';
import { ZONE_GRID, indexCellKey } from '../core/zones/zone-geometry.js';
import { loadConfig, type ServerConfig } from './config.js';
import { wireIdentity, type IdentityWiring } from './identity-wiring.js';
import { wireIngest, type IngestWiring } from './ingest-wiring.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';

const serverDir = fileURLToPath(new URL('../../', import.meta.url));
const dbmateBin = fileURLToPath(new URL('../../node_modules/.bin/dbmate', import.meta.url));
const fixtureDir = join(serverDir, 'fixtures', 'harness-smoke');

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The end-to-end ' +
      'pipeline is only ever run against Postgres here, so skipping it in CI is a false green.',
  );
}

const PUBLIC_ID = /^fw-\d{4}-[a-z0-9]{5}$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const FIRMS_HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight';

const CONFIDENCE_CODE = { low: 'l', nominal: 'n', high: 'h' } as const;

/** One detection as the FIRMS VIIRS Area API writes it. */
function firmsRow(detection: ReplayDetectionInput): string {
  const acqDate = detection.acqTsIso.slice(0, 10);
  const acqTime = detection.acqTsIso.slice(11, 13) + detection.acqTsIso.slice(14, 16);
  return [
    'BGR',
    detection.latCanonical,
    detection.lonCanonical,
    '330.5',
    '0.39',
    '0.36',
    acqDate,
    acqTime,
    'N',
    'VIIRS',
    CONFIDENCE_CODE[detection.confidence],
    '2.0NRT',
    '295.1',
    detection.frpMw === null ? '' : String(detection.frpMw),
    detection.dayNight ?? '',
  ].join(',');
}

/**
 * The Area API over a fixture. Like the real endpoint with `day_range=2`, a poll returns
 * every row published so far for the queried source — earlier polls included — so the
 * second poll re-delivers the first poll's rows, which is the overlap ingest must absorb.
 */
function fixtureFirmsClient(published: () => readonly ReplayBatchInput[]): FirmsAreaClient & {
  readonly queries: FirmsAreaQuery[];
} {
  const queries: FirmsAreaQuery[] = [];
  return {
    queries,
    fetchArea(query) {
      queries.push(query);
      const batches = published();
      const last = batches.at(-1);
      if (last === undefined) throw new Error('fixture client polled before any batch');
      const rows = batches
        .flatMap((batch) => batch.detections)
        .filter((detection) => detection.source === query.source)
        .map(firmsRow);
      return Promise.resolve({
        csv: [FIRMS_HEADER, ...rows].join('\n') + '\n',
        availableAt: last.availableAt,
      });
    },
  };
}

interface EventRow {
  readonly id: string;
  readonly public_id: string;
  readonly seq: string;
  readonly status: string;
  readonly display_tier: string;
  readonly merged_into: string | null;
  readonly detection_count: number;
}

describe.skipIf(!hasDocker)('the worker pipeline, ingest to snapshot, against Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let config: ServerConfig;
  let ingest: IngestWiring;
  let identity: IdentityWiring;
  let readPool: Pool;

  const fixture = loadFixture(fixtureDir);
  const clock = new VirtualClock(fixture.manifest.clockStart);
  let published: ReplayBatchInput[] = [];
  const client = fixtureFirmsClient(() => published);

  /** The FIRMS rows of a fixture batch: the ones the live ingest path can carry. */
  const firmsDetections = (batch: ReplayBatchInput): ReplayDetectionInput[] =>
    batch.detections.filter((detection) => detection.source.startsWith('firms:viirs:'));

  function batch(index: number): ReplayBatchInput {
    const found = fixture.batches[index];
    if (found === undefined) throw new Error(`harness-smoke has no batch ${String(index)}`);
    return found;
  }

  async function poll(): Promise<IngestCycleReport> {
    return runIngestCycle({ ...ingest.deps, client, clock });
  }

  async function cluster(): Promise<IdentityCycleReport> {
    return runIdentityCycle({ ...identity.deps, clock });
  }

  async function snapshot(afterSeq = 0): Promise<SnapshotDocument> {
    const reader = createPgSnapshotReader(readPool);
    const read = await reader.readActiveSet(afterSeq);
    const sources = await reader.readSourceObservations(['firms:viirs:snpp', 'firms:viirs:noaa20']);
    return buildSnapshot({ read, sources, generatedAtMs: clock.now(), afterSeq });
  }

  async function events(): Promise<EventRow[]> {
    const { rows } = await db.query<EventRow>(
      `SELECT e.id::text AS id, e.public_id, e.seq::text AS seq, e.status, e.display_tier,
              e.merged_into::text AS merged_into,
              (SELECT count(*)::int FROM event_detections m WHERE m.fire_event_id = e.id)
                AS detection_count
         FROM fire_events e
        ORDER BY e.id`,
    );
    return rows;
  }

  async function detectionUids(): Promise<string[]> {
    const { rows } = await db.query<{ detection_uid: string }>(
      'SELECT detection_uid FROM detections ORDER BY detection_uid',
    );
    return rows.map((row) => row.detection_uid);
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

    config = loadConfig(
      { DATABASE_URL: databaseUrl, FIRMS_MAP_KEY: '0123456789abcdef0123456789abcdef' },
      'fire-watch-pipeline-itest',
    );
    ingest = wireIngest(config);
    identity = wireIdentity(config);
    // The snapshot and alert stages read as the runtime role too, as the API and the
    // worker's alert loop do.
    readPool = createPgPool({
      databaseUrl: config.databaseUrl,
      role: config.databaseRole,
      applicationName: `${config.applicationName}-read`,
      max: 2,
    });
  }, 300_000);

  afterAll(async () => {
    await ingest?.close();
    await identity?.close();
    await readPool?.end();
    await db?.end();
    await container?.stop();
  });

  it('runs every stage as the runtime role, not the superuser', async () => {
    expect(config.databaseRole).toBe('fire_watch_app');
    const { rows } = await readPool.query<{ current_user: string }>('SELECT current_user');
    expect(rows[0]?.current_user).toBe('fire_watch_app');
  });

  it('ingests the first poll with the uids the fixture pins', async () => {
    published = [batch(0)];
    clock.set(batch(0).availableAt);

    const report = await poll();

    const expected = firmsDetections(batch(0));
    expect(report.sources.every((source) => source.outcome === 'stored')).toBe(true);
    expect(report.sources.reduce((sum, source) => sum + source.inserted, 0)).toBe(expected.length);
    expect(report.sources.reduce((sum, source) => sum + source.quarantined, 0)).toBe(0);
    expect(report.sources.reduce((sum, source) => sum + source.rejected, 0)).toBe(0);
    expect(await detectionUids()).toEqual(expected.map((d) => d.detectionUid).sort());
  });

  it('absorbs a re-poll of the same rows as a no-op', async () => {
    const before = await detectionUids();

    const report = await poll();

    expect(report.sources.reduce((sum, source) => sum + source.inserted, 0)).toBe(0);
    expect(report.sources.reduce((sum, source) => sum + source.alreadyPresent, 0)).toBe(
      before.length,
    );
    expect(await detectionUids()).toEqual(before);
  });

  let firstSeq = 0;
  let firstIds: string[] = [];

  it('clusters the first poll into events the snapshot serves under public ids', async () => {
    const report = await cluster();

    expect(report.batches.applied).toBeGreaterThan(0);
    expect(report.stats.detections).toBe(firmsDetections(batch(0)).length);
    expect(report.stats.seeded).toBeGreaterThan(0);
    expect(report.stats.unattached).toBe(0);

    const rows = await events();
    expect(rows.length).toBe(report.stats.seeded);
    expect(rows.reduce((sum, row) => sum + row.detection_count, 0)).toBe(
      firmsDetections(batch(0)).length,
    );

    const doc = await snapshot();
    expect(doc.partial).toBe(false);
    expect(doc.max_seq).toBeGreaterThan(0);
    expect(doc.features).toHaveLength(rows.length);
    for (const feature of doc.features) {
      expect(feature.id).toMatch(PUBLIC_ID);
      expect(feature.properties.id).toBe(feature.id);
      expect(feature.properties.merged_into).toBeNull();
      expect(feature.properties.seq).toBeLessThanOrEqual(doc.max_seq);
    }
    expect(doc.features.map((f) => f.id).sort()).toEqual(rows.map((r) => r.public_id).sort());
    expect(doc.sources.find((s) => s.source_id === 'firms:viirs:snpp')).toBeDefined();

    firstSeq = doc.max_seq;
    firstIds = doc.features.map((f) => f.id).sort();
  });

  it('re-running the identity cycle changes nothing', async () => {
    const before = await events();

    const report = await cluster();

    expect(report.batches.applied).toBe(0);
    expect(report.stats.seeded).toBe(0);
    expect(report.tick.transitions).toBe(0);
    expect(await events()).toEqual(before);
    const doc = await snapshot();
    expect(doc.max_seq).toBe(firstSeq);
    expect(snapshotEtag(doc.max_seq)).toBe(snapshotEtag(firstSeq));
    expect((await snapshot(firstSeq)).features).toHaveLength(0);
  });

  it('extends the existing event with the second poll instead of minting a duplicate', async () => {
    published = [batch(0), batch(1)];
    clock.set(batch(1).availableAt);
    const before = await events();

    const ingested = await poll();
    // The overlap: poll-01's rows come back and are already there; only poll-02's land.
    expect(ingested.sources.reduce((sum, s) => sum + s.inserted, 0)).toBe(
      firmsDetections(batch(1)).length,
    );
    expect(ingested.sources.reduce((sum, s) => sum + s.alreadyPresent, 0)).toBe(
      firmsDetections(batch(0)).length,
    );

    const report = await cluster();
    expect(report.stats.detections).toBe(firmsDetections(batch(1)).length);
    expect(report.stats.seeded).toBe(0);
    expect(report.stats.attached).toBe(firmsDetections(batch(1)).length);

    const after = await events();
    expect(after.map((row) => row.public_id)).toEqual(before.map((row) => row.public_id));
    expect(after.reduce((sum, row) => sum + row.detection_count, 0)).toBe(
      firmsDetections(batch(0)).length + firmsDetections(batch(1)).length,
    );

    const doc = await snapshot();
    expect(doc.max_seq).toBeGreaterThan(firstSeq);
    expect(doc.features.map((f) => f.id).sort()).toEqual(firstIds);
    const delta = await snapshot(firstSeq);
    expect(delta.partial).toBe(true);
    expect(delta.features.length).toBeGreaterThan(0);
    for (const feature of delta.features) expect(firstIds).toContain(feature.id);
    expect(snapshotEtag(doc.max_seq)).not.toBe(snapshotEtag(firstSeq));
    firstSeq = doc.max_seq;
  });

  it('persists the v0 score on every live event the identity cycle wrote', async () => {
    const { rows } = await db.query<{
      public_id: string;
      score: number;
      score_params_version: string | null;
      invalidated: boolean;
      detection_count: number;
    }>(
      `SELECT e.public_id, e.score, e.score_params_version, e.invalidated,
              (SELECT count(*)::int FROM event_detections m WHERE m.fire_event_id = e.id)
                AS detection_count
         FROM fire_events e
        WHERE e.merged_into IS NULL
        ORDER BY e.id`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.score_params_version).toBe('score_params_v0');
      expect(row.score).toBeGreaterThan(0);
      expect(row.score).toBeLessThanOrEqual(1);
      // No static hot-source mask is loaded, so the §3.6 override cannot fire live.
      expect(row.invalidated).toBe(false);
    }
    // The two-satellite event at the zone centre clears the default 0.45 threshold; the
    // lone low-confidence pixel does not. Both are what `scoreEvent` says of the fixture.
    const scores = rows.map((row) => row.score).sort((a, b) => a - b);
    expect(scores.at(-1)).toBeGreaterThanOrEqual(0.45);
    expect(scores[0]).toBeLessThan(0.45);

    // On the wire the score is a bucket, never the number.
    const doc = await snapshot();
    const byId = new Map(rows.map((row) => [row.public_id, row.score]));
    for (const feature of doc.features) {
      expect(feature.properties.score_bucket).toBe(scoreBucket(byId.get(feature.id) ?? -1));
      expect(feature.properties).not.toHaveProperty('score');
    }
    expect(doc.features.map((f) => f.properties.score_bucket)).toContain('likely');
  });

  it('evaluates the pipeline events for a zone over them, alerting on the one above threshold', async () => {
    const cipher = createAesGcmZoneCipher({
      active: { id: 'test-key', key: new Uint8Array(32).fill(7) },
      retired: [],
    });
    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    const accountId = accounts[0]?.id ?? '';
    const { rows: subscriptions } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint)
       VALUES ($1, 'push', 'https://example.invalid/push/not-a-real-endpoint') RETURNING id`,
      [accountId],
    );
    const channelSubscriptionId = subscriptions[0]?.id ?? '';
    const centre = { lat: 41.85, lon: 26.14 };
    const zoneId = randomUUID();
    await createPgWatchZoneStore(db).insert({
      id: zoneId,
      accountId,
      name: 'Border',
      radiusM: 10_000,
      minScore: 0.45,
      sealed: cipher.seal(zoneId, centre),
      coarsened: false,
      gridVersion: ZONE_GRID.version,
      gridCell: indexCellKey(centre, ZONE_GRID.values),
      createdAtIso: fixture.manifest.clockStart,
    });
    const routing: AlertRouting = {
      targetFor: () => Promise.resolve({ channel: 'push', channelSubscriptionId }),
      copyFor: (decision) => ({
        templateId: `${decision.alertType ?? 'none'}.test.v0`,
        templateParams: {},
      }),
    };

    const report = await runAlertEvaluationCycle({
      store: createPgAlertEvaluationStore(readPool),
      cipher,
      routing,
      clock,
      batchLimit: 50,
      maxBatchesPerCycle: 4,
    });

    const live = await events();
    expect(report.eventsRead).toBe(live.length);
    expect(report.cipherFailures).toBe(0);
    expect(report.pairsDecided).toBe(live.length);
    // The identity cycle now persists the v0 score, so the event whose score clears the
    // zone's threshold alerts: one new_fire row for exactly the in-zone events at or above
    // min_score, provenance pinned to the seq the evaluation read.
    const { rows: eligible } = await db.query<{ id: string; seq: string }>(
      `SELECT e.id::text AS id, e.seq::text AS seq
         FROM fire_events e
        WHERE e.merged_into IS NULL AND e.score >= 0.45
        ORDER BY e.id`,
    );
    expect(eligible.length).toBeGreaterThan(0);
    expect(report.outboxInserted).toBe(eligible.length);
    const { rows: outbox } = await db.query<{
      watch_zone_id: string;
      fire_event_id: string;
      alert_type: string;
      trigger_ref_seq: string;
      template_id: string;
      channel: string;
      channel_subscription_id: string;
    }>(
      `SELECT watch_zone_id::text, fire_event_id::text, alert_type, trigger_ref_seq::text,
              template_id, channel, channel_subscription_id::text
         FROM alert_outbox
        ORDER BY fire_event_id`,
    );
    expect(outbox).toEqual(
      eligible.map((event) => ({
        watch_zone_id: zoneId,
        fire_event_id: event.id,
        alert_type: 'new_fire',
        trigger_ref_seq: event.seq,
        template_id: 'new_fire.test.v0',
        channel: 'push',
        channel_subscription_id: channelSubscriptionId,
      })),
    );

    const again = await runAlertEvaluationCycle({
      store: createPgAlertEvaluationStore(readPool),
      cipher,
      routing,
      clock,
      batchLimit: 50,
      maxBatchesPerCycle: 4,
    });
    expect(again).toMatchObject({ eventsRead: 0, pairsDecided: 0, outboxInserted: 0 });
    const { rows: after } = await db.query('SELECT 1 FROM alert_outbox');
    expect(after).toHaveLength(outbox.length);
  });

  it('closes the silent events through the lifecycle tick and walks them off the map', async () => {
    const ids = (await events()).map((row) => row.public_id);
    let transitions = 0;
    let lastSeq = firstSeq;
    const lastAcqMs = epochMsFromIso(
      firmsDetections(batch(1))
        .map((d) => d.acqTsIso)
        .sort()
        .at(-1) ?? '',
    );
    /** Per event, the first tick instant it was seen closed, off the map, and archived. */
    const closedAt = new Map<string, number>();
    const closedWith = new Map<string, string | null>();
    const offMapAt = new Map<string, number>();
    const archivedAt = new Map<string, number>();
    let snapshotEmptyAt: number | null = null;

    // Hourly ticks for a month of silence: no new detections, no cloud field, no
    // declarations. Every pass is therefore cloud-blocked, no miss evidence accumulates,
    // and the A2.3(3) unobservability fallback is the only rule that can close them.
    for (let hour = 0; hour < 30 * 24; hour += 1) {
      clock.advanceMs(HOUR_MS);
      const report = await cluster();
      expect(report.batches.applied).toBe(0);
      expect(report.tick.missing).toBe(0);
      transitions += report.tick.transitions;
      const doc = await snapshot();
      expect(doc.max_seq).toBeGreaterThanOrEqual(lastSeq);
      if (report.tick.transitions > 0) expect(doc.max_seq).toBeGreaterThan(lastSeq);
      lastSeq = doc.max_seq;
      if (snapshotEmptyAt === null && doc.features.length === 0) snapshotEmptyAt = clock.now();

      const { rows } = await db.query<{
        public_id: string;
        status: string;
        status_reason: string | null;
        display_tier: string;
      }>('SELECT public_id, status, status_reason, display_tier FROM fire_events');
      for (const row of rows) {
        if (row.status !== 'active' && !closedAt.has(row.public_id)) {
          closedAt.set(row.public_id, clock.now());
          closedWith.set(row.public_id, `${row.status}/${row.status_reason ?? ''}`);
        }
        if (row.display_tier !== 'map' && !offMapAt.has(row.public_id)) {
          offMapAt.set(row.public_id, clock.now());
        }
        if (row.status === 'archived' && !archivedAt.has(row.public_id)) {
          archivedAt.set(row.public_id, clock.now());
        }
      }
    }

    const rows = await events();
    expect(rows.map((row) => row.public_id)).toEqual(ids);
    expect(transitions).toBeGreaterThan(0);
    for (const id of ids) {
      // Closed by the fallback, and not before a fortnight of silence (the dwell half of
      // the rule) — nor more than a day and a tick after it (the whole-UTC-day half).
      expect(closedWith.get(id)).toBe('no_longer_detected/unobservable');
      const closed = closedAt.get(id) ?? Number.NaN;
      expect(closed - lastAcqMs).toBeGreaterThanOrEqual(14 * DAY_MS);
      expect(closed - lastAcqMs).toBeLessThan(16 * DAY_MS);
      // Then the display window: off the map after 48 h, archived after 7 days.
      const offMap = (offMapAt.get(id) ?? Number.NaN) - closed;
      expect(offMap).toBeGreaterThanOrEqual(48 * HOUR_MS);
      expect(offMap).toBeLessThan(49 * HOUR_MS);
      const archived = (archivedAt.get(id) ?? Number.NaN) - closed;
      expect(archived).toBeGreaterThanOrEqual(7 * DAY_MS);
      expect(archived).toBeLessThan(7 * DAY_MS + HOUR_MS);
    }
    for (const row of rows) {
      expect(row.status).toBe('archived');
      expect(row.display_tier).toBe('archive');
      expect(row.merged_into).toBeNull();
    }
    expect(snapshotEmptyAt).toBe(Math.max(...offMapAt.values()));
    expect((await snapshot()).features).toHaveLength(0);
    expect(lastSeq).toBeGreaterThan(firstSeq);
  }, 600_000);
});
