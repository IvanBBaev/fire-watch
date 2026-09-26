/**
 * The state-machine store against a real Postgres, because everything H3 promises is a
 * promise about the database rather than about the module: that an unknown event id fails
 * the write whole instead of dropping one pair, that the upsert replaces a row rather than
 * merging into it, that `alert_states.watch_zone_id` cascades — which is the *only* thing
 * making A1.8's "a zone deleted and re-created re-seeds from scratch" true — and that the
 * runtime role may delete here, which it may not do in the outbox.
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

import type { AlertStateRow } from '../../core/registry/alert-state.js';
import { createPgAlertStateStore, type PgAlertStateQueryable } from './pg-alert-state-store.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The alert-state SQL is ' +
      'only ever executed here, so skipping it in CI is a false green.',
  );
}

const SEEDED_AT = '2026-08-01T06:00:00.000Z';
const NOTIFIED_AT = '2026-08-02T11:29:30.000Z';
const LATER_NOTIFIED_AT = '2026-08-02T17:04:00.000Z';

const NEAR = 'fw-2026-q7f3d';
const FAR = 'fw-2026-b2k9m';

interface StoredRow extends Record<string, unknown> {
  readonly watch_zone_id: string;
  readonly fire_event_id: string;
  readonly state: string;
  readonly escalation_watermark: number;
  readonly seeded_at: Date | null;
  readonly last_notified_at: Date | null;
  readonly updated_at: Date;
}

describe.skipIf(!hasDocker)('the alert-state store', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let store: ReturnType<typeof createPgAlertStateStore>;

  let zoneId: string;
  let secondZoneId: string;
  let accountId: string;

  function row(overrides: Partial<AlertStateRow> = {}): AlertStateRow {
    return {
      zoneId,
      eventPublicId: NEAR,
      state: 'notified_new',
      escalationWatermark: 0,
      seededAtIso: SEEDED_AT,
      lastNotifiedAtIso: null,
      ...overrides,
    };
  }

  async function storedRows(): Promise<StoredRow[]> {
    const { rows } = await db.query<StoredRow>(
      'SELECT * FROM alert_states ORDER BY watch_zone_id, fire_event_id',
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
    // A `Client` is a `PgAlertStateQueryable`. If that ever stops type-checking, the store
    // grew a dependency on something wider than the slice of pg it declares.
    const queryable: PgAlertStateQueryable = db;
    store = createPgAlertStateStore(queryable);

    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    accountId = accounts[0]?.id ?? '';

    await db.query(
      `INSERT INTO fire_events (
         public_id, status, status_changed_at, started_at, last_detection_at,
         centroid, score, config_version, source_registry_version
       )
       VALUES ($1, 'active', $3, $3, $3,
               ST_SetSRID(ST_MakePoint(23.30, 42.60), 4326), 0.82,
               'clustering_v1', 'source_registry_v1'),
              ($2, 'active', $3, $3, $3,
               ST_SetSRID(ST_MakePoint(23.57, 42.15), 4326), 0.61,
               'clustering_v1', 'source_registry_v1')`,
      [NEAR, FAR, NOTIFIED_AT],
    );
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    // Zones are re-created per test: the cascade is one of the things under test, so a
    // test that deletes a zone must not take the next test's fixture with it.
    await db.query('DELETE FROM alert_states');
    await db.query('DELETE FROM watch_zones');
    const { rows: zones } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Vitosha', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000),
              ($1, 'Rila',    ST_GeogFromText('SRID=4326;POINT(23.55 42.13)'), 5000)
       RETURNING id`,
      [accountId],
    );
    zoneId = zones[0]?.id ?? '';
    secondZoneId = zones[1]?.id ?? '';
  });

  describe('the A1.8 seed', () => {
    it('stores notified_new with a seed instant and nothing notified', async () => {
      expect(await store.upsert([row()])).toBe(1);

      const [stored] = await storedRows();
      expect(stored).toMatchObject({
        state: 'notified_new',
        escalation_watermark: 0,
        last_notified_at: null,
      });
      expect(stored?.seeded_at?.toISOString()).toBe(SEEDED_AT);
    });

    it('comes back through the public id the core decided on', async () => {
      await store.upsert([row()]);

      expect(await store.loadStates([{ zoneId, eventPublicId: NEAR }])).toEqual([
        {
          zoneId,
          eventPublicId: NEAR,
          state: 'notified_new',
          escalationWatermark: 0,
          seededAtIso: SEEDED_AT,
          lastNotifiedAtIso: null,
        },
      ]);
    });

    it('leaves a seeded pair out of the cross-event suppression instant', async () => {
      // A seed sent nothing, so it must not start a suppression window. `last_notified_at`
      // is null, the aggregate skips the row, and the zone is simply absent from the map.
      await store.upsert([row()]);
      expect((await store.lastNotifiedByZone([zoneId])).has(zoneId)).toBe(false);
    });

    it('is taken with the zone, so a re-created zone re-seeds from scratch', async () => {
      await store.upsert([row()]);
      await db.query('DELETE FROM watch_zones WHERE id = $1', [zoneId]);

      expect(await storedRows()).toEqual([]);
    });
  });

  describe('the write', () => {
    it('fails whole rather than dropping the pair whose event does not exist', async () => {
      await expect(store.upsert([row(), row({ eventPublicId: 'fw-2026-zzzzz' })])).rejects.toThrow(
        /fire_event_id/,
      );

      // The good half of the batch is not in the table either: one statement, one fate.
      expect(await storedRows()).toEqual([]);
    });

    it('replaces the row rather than merging into it', async () => {
      await store.upsert([row()]);
      await store.upsert([
        row({
          state: 'notified_escalation',
          escalationWatermark: 2,
          seededAtIso: SEEDED_AT,
          lastNotifiedAtIso: NOTIFIED_AT,
        }),
      ]);

      const [stored] = await storedRows();
      expect(stored).toMatchObject({ state: 'notified_escalation', escalation_watermark: 2 });
      expect(stored?.last_notified_at?.toISOString()).toBe(NOTIFIED_AT);
      expect(await storedRows()).toHaveLength(1);
    });

    it('clears a column the decision cleared, which a partial update never would', async () => {
      await store.upsert([row({ lastNotifiedAtIso: NOTIFIED_AT })]);
      await store.upsert([row({ seededAtIso: null, lastNotifiedAtIso: null })]);

      const [stored] = await storedRows();
      expect(stored?.seeded_at).toBeNull();
      expect(stored?.last_notified_at).toBeNull();
    });

    it('moves updated_at on the second write', async () => {
      await store.upsert([row()]);
      const [first] = await storedRows();
      await db.query('SELECT pg_sleep(0.01)');
      await store.upsert([row({ state: 'notified_escalation', escalationWatermark: 1 })]);
      const [second] = await storedRows();

      expect(second?.updated_at.getTime()).toBeGreaterThan(first?.updated_at.getTime() ?? 0);
    });

    it('writes both zones of one event in one batch', async () => {
      expect(await store.upsert([row(), row({ zoneId: secondZoneId })])).toBe(2);
      expect(await storedRows()).toHaveLength(2);
    });
  });

  describe('the reads', () => {
    beforeEach(async () => {
      await store.upsert([
        row({ lastNotifiedAtIso: NOTIFIED_AT }),
        row({ eventPublicId: FAR, lastNotifiedAtIso: LATER_NOTIFIED_AT }),
        row({ zoneId: secondZoneId, eventPublicId: FAR }),
      ]);
    });

    it('returns the pairs asked for and no others', async () => {
      const loaded = await store.loadStates([
        { zoneId, eventPublicId: NEAR },
        { zoneId: secondZoneId, eventPublicId: NEAR },
      ]);

      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.zoneId).toBe(zoneId);
      expect(loaded[0]?.eventPublicId).toBe(NEAR);
    });

    it('reads an event across every zone following it, which a merge needs', async () => {
      const loaded = await store.loadStatesForEvents([FAR]);

      expect(loaded.map((state) => state.zoneId).sort()).toEqual([zoneId, secondZoneId].sort());
    });

    it('takes the zone instant from the latest of its events, not the latest row written', async () => {
      const notified = await store.lastNotifiedByZone([zoneId, secondZoneId]);

      expect(notified.get(zoneId)).toBe(LATER_NOTIFIED_AT);
      // The second zone holds only a seeded pair, so it has never notified anything.
      expect(notified.has(secondZoneId)).toBe(false);
    });
  });

  describe('the removal', () => {
    it('removes what the merge migration names and reports how many it found', async () => {
      await store.upsert([row(), row({ eventPublicId: FAR })]);

      expect(
        await store.remove([
          { zoneId, eventPublicId: NEAR },
          { zoneId, eventPublicId: 'fw-2026-zzzzz' },
        ]),
      ).toBe(1);
      expect((await storedRows()).map((stored) => stored.state)).toEqual(['notified_new']);
    });

    it('is replayable, because an already-deleted key is not an error', async () => {
      await store.upsert([row()]);
      expect(await store.remove([{ zoneId, eventPublicId: NEAR }])).toBe(1);
      expect(await store.remove([{ zoneId, eventPublicId: NEAR }])).toBe(0);
    });
  });

  describe('the runtime role', () => {
    beforeEach(async () => {
      // After the outer fixture, which the runtime role has no business writing.
      await db.query('SET ROLE fire_watch_app');
    });

    afterEach(async () => {
      await db.query('RESET ROLE');
    });

    it('may delete here, unlike in the outbox, because I3 folds parents onto a survivor', async () => {
      await store.upsert([row()]);
      expect(await store.remove([{ zoneId, eventPublicId: NEAR }])).toBe(1);
    });
  });
});
