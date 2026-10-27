/**
 * The worker loop locks against a real Postgres: two workers' cycles of one loop never
 * run at the same time, different loops never block each other, the lock is free again
 * after a cycle (including one that threw), and a session that dies holding a lock gives
 * it up — the property the standby's takeover rests on. Taken as `fire_watch_app`, so the
 * test also shows the lock needs no grant the role does not have.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgLoopLocks, LOOP_LOCK_KEYS, WORKER_LOOP_LOCK_CLASS } from './pg-loop-lock.js';
import { createPgPool } from './pg-pool.js';
import type { LoopLocks } from '../../core/ports/loop-lock.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The worker loop lock is ' +
      'only ever executed against Postgres here, so skipping it in CI is a false green.',
  );
}

/** A promise and the function that settles it: the test's stand-in for a long cycle. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe.skipIf(!hasDocker)('worker loop locks', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  // Two workers: separate pools, separate sessions, the same database.
  let first: LoopLocks;
  let second: LoopLocks;
  let admin: Pool;

  const workerLocks = (name: string): LoopLocks =>
    createPgLoopLocks(
      createPgPool({ databaseUrl, role: 'fire_watch_app', applicationName: name, max: 3 }),
    );

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    first = workerLocks('worker-a-loop-locks');
    second = workerLocks('worker-b-loop-locks');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
  }, 300_000);

  afterAll(async () => {
    await Promise.all([first?.close(), second?.close(), admin?.end()]);
    await container?.stop();
  });

  it('never runs two workers’ cycles of one loop at the same time', async () => {
    const holding = gate();
    let running = 0;
    let peak = 0;
    let bodies = 0;
    const cycle = async (): Promise<string> => {
      bodies += 1;
      running += 1;
      peak = Math.max(peak, running);
      await holding.promise;
      running -= 1;
      return 'done';
    };

    const a = first.forLoop('dispatch').runExclusive(cycle);
    // Wait until A's body is inside the lock before B asks.
    while (bodies === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const b = await second.forLoop('dispatch').runExclusive(cycle);
    holding.open();

    expect(b).toEqual({ acquired: false });
    expect(await a).toEqual({ acquired: true, value: 'done' });
    expect(bodies).toBe(1);
    expect(peak).toBe(1);

    // The holder let go: the standby's next cycle runs.
    expect(await second.forLoop('dispatch').runExclusive(() => Promise.resolve('b'))).toEqual({
      acquired: true,
      value: 'b',
    });
  });

  it('lets two different loops run at once, in one worker or across two', async () => {
    const holding = gate();
    const inside: string[] = [];
    const cycle = (name: string) => async (): Promise<string> => {
      inside.push(name);
      await holding.promise;
      return name;
    };

    const runs = [
      first.forLoop('ingest').runExclusive(cycle('ingest')),
      first.forLoop('alert_evaluation').runExclusive(cycle('alert_evaluation')),
      second.forLoop('dispatch').runExclusive(cycle('dispatch')),
    ];
    while (inside.length < 3) await new Promise((resolve) => setTimeout(resolve, 10));
    holding.open();

    expect((await Promise.all(runs)).map((run) => run.acquired)).toEqual([true, true, true]);
  });

  it('frees the lock after a cycle that threw', async () => {
    await expect(
      first.forLoop('ingest').runExclusive(() => Promise.reject(new Error('EAI_AGAIN'))),
    ).rejects.toThrow('EAI_AGAIN');
    expect((await second.forLoop('ingest').runExclusive(() => Promise.resolve(1))).acquired).toBe(
      true,
    );
  });

  it('gives the lock up with the session that held it, so a dead holder blocks nobody', async () => {
    const holding = gate();
    let inside = false;
    const doomed = first.forLoop('alert_evaluation').runExclusive(async () => {
      inside = true;
      await holding.promise;
    });
    while (!inside) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      (await second.forLoop('alert_evaluation').runExclusive(() => Promise.resolve(1))).acquired,
    ).toBe(false);

    // The holder's connection drops (an OOM kill, a network partition).
    const { rowCount } = await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND granted`,
      [WORKER_LOOP_LOCK_CLASS, LOOP_LOCK_KEYS.alert_evaluation],
    );
    expect(rowCount).toBe(1);

    expect(
      (await second.forLoop('alert_evaluation').runExclusive(() => Promise.resolve(1))).acquired,
    ).toBe(true);
    holding.open();
    // The dead holder's own cycle finishes; its unlock fails and the client is destroyed.
    await doomed;
  });
});
