/**
 * The meta-alert state store against a real Postgres (TASKS J1; migration 036): a state
 * written by one worker is read back intact by another, two workers' updates are
 * serialised by the advisory lock (the second reads what the first wrote), a decision that
 * throws leaves the stored rows as they were, and the table's CHECKs refuse a row the
 * evaluator could never produce. Run as `fire_watch_app`, so the grants are covered too.
 *
 * Skipped when there is no Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1` turns that skip
 * into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { StoredMetaAlertState } from '../../core/monitoring/meta-alert-memory.js';
import type { MetaAlertKey } from '../../core/monitoring/meta-alert-params.js';
import { epochMsFromIso } from '../../core/ports/clock.js';
import type { MetaAlertStateStore } from '../../core/ports/meta-alert-state-store.js';
import { createPgMetaAlertStateStore } from './pg-meta-alert-state-store.js';
import { createPgPool } from './pg-pool.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = process.env['FIRE_WATCH_PG_IMAGE'] ?? 'postgis/postgis:16-3.4';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The meta-alert state ' +
      'store is only ever executed against Postgres here, so skipping it in CI is a false green.',
  );
}

const T = epochMsFromIso('2026-10-27T10:00:00.000Z');

const paging = (evaluatedAt: number, breachStreak: number): StoredMetaAlertState => ({
  state: { paging: true, breachStreak, clearStreak: 0, pagingSince: T - 120_000 },
  evaluatedAt,
});

describe.skipIf(!hasDocker)('pg meta-alert state store', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let pools: ReturnType<typeof createPgPool>[] = [];
  let first: MetaAlertStateStore;
  let second: MetaAlertStateStore;
  let admin: Pool;

  const workerStore = (name: string): MetaAlertStateStore => {
    const pool = createPgPool({
      databaseUrl,
      role: 'fire_watch_app',
      applicationName: name,
      max: 2,
    });
    pools.push(pool);
    return createPgMetaAlertStateStore(pool);
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    pools = [];
    first = workerStore('worker-a-meta-alert-states');
    second = workerStore('worker-b-meta-alert-states');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
  }, 300_000);

  afterAll(async () => {
    await Promise.all([...pools.map((pool) => pool.end()), admin?.end()]);
    await container?.stop();
  });

  it('round-trips a stored state between two workers and overwrites it on conflict', async () => {
    const key: MetaAlertKey = 'outbox_queue_oldest_seconds';
    await first.update(() => ({ write: new Map([[key, paging(T, 2)]]), result: null }));
    const read = await second.update((stored) => ({ write: null, result: stored.get(key) }));
    expect(read).toEqual(paging(T, 2));

    await second.update(() => ({
      write: new Map([[key, paging(T + 60_000, 3)]]),
      result: null,
    }));
    const again = await first.update((stored) => ({ write: null, result: stored.get(key) }));
    expect(again).toEqual(paging(T + 60_000, 3));
  });

  it('serialises two workers: the second decides on what the first wrote', async () => {
    const key: MetaAlertKey = 'outbox_pending_rows';
    const increment = (stored: ReadonlyMap<string, StoredMetaAlertState>) => {
      const previous = stored.get(key)?.state.breachStreak ?? 0;
      const next: StoredMetaAlertState = {
        state: { paging: false, breachStreak: previous + 1, clearStreak: 0, pagingSince: null },
        evaluatedAt: T,
      };
      return { write: new Map([[key, next]]), result: previous };
    };
    const seen = await Promise.all([
      ...Array.from({ length: 5 }, () => first.update(increment)),
      ...Array.from({ length: 5 }, () => second.update(increment)),
    ]);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('leaves the stored rows untouched when a decision throws', async () => {
    const key: MetaAlertKey = 'identity_pending_batches';
    await first.update(() => ({ write: new Map([[key, paging(T, 2)]]), result: null }));
    await expect(
      second.update(() => {
        throw new Error('bad rule');
      }),
    ).rejects.toThrow('bad rule');
    const read = await first.update((stored) => ({ write: null, result: stored.get(key) }));
    expect(read).toEqual(paging(T, 2));
  });

  it('refuses a row the evaluator could never produce', async () => {
    await expect(
      first.update(() => ({
        write: new Map([
          [
            'canary_round_trip_seconds',
            {
              state: { paging: true, breachStreak: 2, clearStreak: 0, pagingSince: null },
              evaluatedAt: T,
            },
          ],
        ]),
        result: null,
      })),
    ).rejects.toThrow(/meta_alert_states_paging_since/);
    const { rows } = await admin.query(
      `SELECT class FROM table_backup_class WHERE table_name = 'meta_alert_states'`,
    );
    expect(rows).toEqual([{ class: 'main' }]);
  });
});
