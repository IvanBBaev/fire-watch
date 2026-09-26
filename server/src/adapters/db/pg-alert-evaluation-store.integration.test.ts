/**
 * The live alert loop against a real Postgres: migration 009's cursor and marks, the
 * member aggregates of the alertable-event projection, the seed-candidate reader's spatial
 * prefilter, and one whole `runAlertEvaluationCycle` over a sealed zone — the only place
 * the SQL of these adapters is executed.
 *
 * Skipped when there is no Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that
 * skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SOURCE_REGISTRY_VERSION } from '@fire-watch/contracts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runAlertEvaluationCycle } from '../../core/alerts/evaluation-cycle.js';
import { ZONE_MATCH_METRIC } from '../../core/alerts/zone-match.js';
import { VirtualClock } from '../../core/ports/clock.js';
import type { AlertRouting } from '../../core/ports/alert-routing.js';
import { ZONE_GRID, indexCellKey } from '../../core/zones/zone-geometry.js';
import { createAesGcmZoneCipher } from '../crypto/aes-gcm-zone-cipher.js';
import { createPgAlertEvaluationStore } from './pg-alert-evaluation-store.js';
import { createPgWatchZoneStore } from './pg-watch-zone-store.js';
import { createPgZoneSeedCandidateReader } from './pg-zone-seed-candidate-reader.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The alert evaluation ' +
      'SQL is only ever executed here, so skipping it in CI is a false green.',
  );
}

const NOON = '2026-08-14T12:00:00.000Z';
const CENTRE = { lat: 42.6, lon: 23.3 };
const uid = (n: number): string => n.toString(16).padStart(64, '0');
const kmNorth = (km: number): number => CENTRE.lat + km / ZONE_MATCH_METRIC.kmPerDegreeLat;

const cipher = createAesGcmZoneCipher({
  active: { id: 'test-key', key: new Uint8Array(32).fill(7) },
  retired: [],
});

describe.skipIf(!hasDocker)('the live alert evaluation adapters', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let accountId = '';
  let subscriptionId = '';
  let runId = '';
  let detectionN = 0;

  async function insertEvent(
    publicId: string,
    lat: number,
    fields: { mergedInto?: string; relatedTo?: string; score?: number } = {},
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at, centroid, score,
         config_version, source_registry_version, merged_into, related_event_id, relation_kind
       ) VALUES ($1, 'active', $2, $2, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5,
                 'clustering_v1', 'source_registry_v1', $6, $7,
                 CASE WHEN $7::bigint IS NULL THEN NULL ELSE 'continuation' END)
       RETURNING id::text AS id`,
      [
        publicId,
        NOON,
        CENTRE.lon,
        lat,
        fields.score ?? 0.9,
        fields.mergedInto ?? null,
        fields.relatedTo ?? null,
      ],
    );
    return rows[0]?.id ?? '';
  }

  async function attach(
    eventId: string,
    member: { tier?: string; quarantined?: boolean; attachedAt?: string } = {},
  ): Promise<void> {
    detectionN += 1;
    const acq = '2026-08-14T11:00:00.000Z';
    await db.query(
      `INSERT INTO detections (
         detection_uid, source, product_tier, acq_ts, available_at, lat, lon,
         confidence_raw, confidence, source_registry_version, ingest_config_version, quarantined
       ) VALUES ($1, 'firms:viirs:snpp', $2, $3, $3, 42.6, 23.3, 'n', 'nominal', $4, 'ingest_v1', $5)`,
      [
        uid(detectionN),
        member.tier ?? 'NRT',
        acq,
        SOURCE_REGISTRY_VERSION,
        member.quarantined ?? false,
      ],
    );
    await db.query(
      `INSERT INTO event_detections (clustering_run_id, fire_event_id, detection_uid, acq_ts, attached_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [runId, eventId, uid(detectionN), acq, member.attachedAt ?? NOON],
    );
  }

  async function insertZone(radiusM: number): Promise<string> {
    const id = randomUUID();
    await createPgWatchZoneStore(db).insert({
      id,
      accountId,
      name: 'Vitosha',
      radiusM,
      minScore: 0.45,
      sealed: cipher.seal(id, CENTRE),
      coarsened: false,
      gridVersion: ZONE_GRID.version,
      gridCell: indexCellKey(CENTRE, ZONE_GRID.values),
      createdAtIso: NOON,
    });
    return id;
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
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE alert_outbox, alert_states, alert_evaluated_events, alert_evaluation_cursor,
                event_detections, watch_zones, channel_subscriptions, accounts, clustering_runs,
                fire_events, detections CASCADE`,
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
    const { rows: runs } = await db.query<{ id: string }>(
      `INSERT INTO clustering_runs (kind, config_version, config_digest)
       VALUES ('live', 'clustering_v1', 'abcd1234') RETURNING id::text AS id`,
    );
    runId = runs[0]?.id ?? '';
  });

  const routing = (): AlertRouting => ({
    targetFor: () => Promise.resolve({ channel: 'push', channelSubscriptionId: subscriptionId }),
    copyFor: (decision) => ({
      templateId: `${decision.alertType ?? 'none'}.test.v0`,
      templateParams: {},
    }),
  });

  it('reads the member aggregates and excludes nothing the core should see', async () => {
    const id = await insertEvent('fw-2026-aaaaa', CENTRE.lat);
    await attach(id, { tier: 'GEO', attachedAt: '2026-08-14T11:10:00Z' });
    await attach(id, { quarantined: true, attachedAt: '2026-08-14T11:20:00Z' });
    const store = createPgAlertEvaluationStore(pool);

    const rows = await store.withTransaction((tx) => tx.readEventsAfter('0', 10));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberCount: 2, merged: false, superseded: false });
    expect(rows[0]?.event).toMatchObject({
      detectionCount: 1,
      geoOnly: true,
      quarantined: true,
      statusBefore: null,
    });
  });

  it('flags merged tombstones and superseded parents', async () => {
    const survivor = await insertEvent('fw-2026-aaaaa', CENTRE.lat);
    await insertEvent('fw-2026-bbbbb', CENTRE.lat, { mergedInto: survivor });
    const parent = await insertEvent('fw-2026-ccccc', CENTRE.lat);
    await insertEvent('fw-2026-ddddd', CENTRE.lat, { relatedTo: parent });
    const store = createPgAlertEvaluationStore(pool);

    const rows = await store.withTransaction((tx) => tx.readEventsAfter('0', 10));
    const flags = Object.fromEntries(
      rows.map((r) => [r.event.publicId, { merged: r.merged, superseded: r.superseded }]),
    );

    expect(flags).toEqual({
      'fw-2026-aaaaa': { merged: false, superseded: false },
      'fw-2026-bbbbb': { merged: true, superseded: false },
      'fw-2026-ccccc': { merged: false, superseded: true },
      'fw-2026-ddddd': { merged: false, superseded: false },
    });
  });

  it('keeps the cursor forward-only and rolls it back with the batch', async () => {
    const store = createPgAlertEvaluationStore(pool);
    await store.withTransaction((tx) => tx.advanceCursor('5', NOON));
    await expect(store.withTransaction((tx) => tx.advanceCursor('4', NOON))).rejects.toThrow(
      /back/,
    );
    await expect(
      store.withTransaction(async (tx) => {
        await tx.advanceCursor('9', NOON);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.withTransaction((tx) => tx.readCursor())).toBe('5');
  });

  it('runs a whole cycle: one send, one state, one outbox row, cursor at the last seq', async () => {
    const zoneId = await insertZone(10_000);
    const inside = await insertEvent('fw-2026-aaaaa', kmNorth(4));
    await attach(inside);
    await attach(inside);
    const outside = await insertEvent('fw-2026-bbbbb', kmNorth(12));
    await attach(outside);
    await attach(outside);
    const deps = {
      store: createPgAlertEvaluationStore(pool),
      cipher,
      routing: routing(),
      clock: new VirtualClock(NOON),
      batchLimit: 10,
      maxBatchesPerCycle: 3,
    };

    const report = await runAlertEvaluationCycle(deps);

    expect(report).toMatchObject({
      eventsRead: 2,
      pairsDecided: 1,
      statesWritten: 1,
      outboxInserted: 1,
      cipherFailures: 0,
    });
    const { rows: states } = await db.query<{ watch_zone_id: string; state: string }>(
      'SELECT watch_zone_id::text, state FROM alert_states',
    );
    expect(states).toEqual([{ watch_zone_id: zoneId, state: 'notified_new' }]);
    const { rows: outbox } = await db.query<{ status: string; trigger_ref_seq: string }>(
      'SELECT status, trigger_ref_seq::text FROM alert_outbox',
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.status).toBe('pending');
    const { rows: marks } = await db.query('SELECT * FROM alert_evaluated_events');
    expect(marks).toHaveLength(2);

    // A second cycle with nothing new reads nothing and writes nothing.
    const idle = await runAlertEvaluationCycle(deps);
    expect(idle).toMatchObject({ eventsRead: 0, outboxInserted: 0 });
    expect(idle.cursorFrom).toBe(report.cursorTo);
  });

  it('seeds from the same projection and the same distance', async () => {
    const near = await insertEvent('fw-2026-aaaaa', kmNorth(3));
    await attach(near);
    const far = await insertEvent('fw-2026-bbbbb', kmNorth(7));
    await attach(far);
    const empty = await insertEvent('fw-2026-ccccc', kmNorth(1));
    void empty;

    const candidates = await createPgZoneSeedCandidateReader(db).candidatesWithin(CENTRE, 5_000);

    expect(candidates.map((c) => c.event.publicId)).toEqual(['fw-2026-aaaaa']);
    expect(candidates[0]?.distanceKm).toBeCloseTo(3, 3);
  });
});
