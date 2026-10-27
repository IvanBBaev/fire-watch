import { describe, expect, it } from 'vitest';

import { LOCKED_LOOPS } from '../../core/ports/loop-lock.js';
import {
  createPgLoopLock,
  createPgLoopLocks,
  LOOP_LOCK_KEYS,
  LOOP_LOCK_SQL,
  WORKER_LOOP_LOCK_CLASS,
  type PgLoopLockClient,
  type PgLoopLockPool,
} from './pg-loop-lock.js';

interface FakeClient extends PgLoopLockClient {
  readonly queries: [text: string, values: readonly unknown[] | undefined][];
  readonly releases: (boolean | undefined)[];
  /** The error listener the lock attached, while it is attached. */
  listener: ((error: Error) => void) | null;
}

interface Answers {
  acquired?: boolean | Error;
  released?: boolean | Error;
}

/** A client that answers the two statements with whatever the test says. */
function fakePool(answers: Answers): PgLoopLockPool & { clients: FakeClient[]; ended: number } {
  const pool = {
    clients: [] as FakeClient[],
    ended: 0,
    connect(): Promise<PgLoopLockClient> {
      const client: FakeClient = {
        queries: [],
        releases: [],
        query<Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<{ rows: Row[] }> {
          client.queries.push([text, values]);
          const answer = text === LOOP_LOCK_SQL.tryLock ? answers.acquired : answers.released;
          if (answer instanceof Error) return Promise.reject(answer);
          const column = text === LOOP_LOCK_SQL.tryLock ? 'acquired' : 'released';
          return Promise.resolve({ rows: [{ [column]: answer ?? true } as unknown as Row] });
        },
        release(destroy?: boolean): void {
          client.releases.push(destroy);
        },
        listener: null,
        on(_event: 'error', listener: (error: Error) => void) {
          client.listener = listener;
          return client;
        },
        removeListener() {
          client.listener = null;
          return client;
        },
      };
      pool.clients.push(client);
      return Promise.resolve(client);
    },
    end(): Promise<void> {
      pool.ended += 1;
      return Promise.resolve();
    },
  };
  return pool;
}

describe('pg loop lock', () => {
  it('keeps its own lock space: the two-key form under its own class, a fixed key per loop', () => {
    expect(LOOP_LOCK_SQL.tryLock).toContain(
      `pg_try_advisory_lock(${String(WORKER_LOOP_LOCK_CLASS)},`,
    );
    expect(LOOP_LOCK_SQL.unlock).toContain(`pg_advisory_unlock(${String(WORKER_LOOP_LOCK_CLASS)},`);
    // Sign-in's and the opt-in's classes; the clustering store uses the single-key form.
    expect([7007, 7012]).not.toContain(WORKER_LOOP_LOCK_CLASS);
    const keys = LOCKED_LOOPS.map((loop) => LOOP_LOCK_KEYS[loop]);
    expect(new Set(keys).size).toBe(LOCKED_LOOPS.length);
  });

  it('runs the body under the lock, unlocks, and pools the client again', async () => {
    const pool = fakePool({ acquired: true, released: true });
    const result = await createPgLoopLock(pool, 'dispatch').runExclusive(() => Promise.resolve(42));

    expect(result).toEqual({ acquired: true, value: 42 });
    const [client] = pool.clients;
    expect(client?.queries).toEqual([
      [LOOP_LOCK_SQL.tryLock, [LOOP_LOCK_KEYS.dispatch]],
      [LOOP_LOCK_SQL.unlock, [LOOP_LOCK_KEYS.dispatch]],
    ]);
    expect(client?.releases).toEqual([false]);
  });

  it('skips the body when another session holds the lock', async () => {
    const pool = fakePool({ acquired: false });
    let ran = false;
    const result = await createPgLoopLock(pool, 'ingest').runExclusive(() => {
      ran = true;
      return Promise.resolve(1);
    });

    expect(result).toEqual({ acquired: false });
    expect(ran).toBe(false);
    // Nothing to unlock, and the connection holds nothing: it goes back to the pool.
    expect(pool.clients[0]?.queries).toHaveLength(1);
    expect(pool.clients[0]?.releases).toEqual([false]);
  });

  it('unlocks after a body that threw, and rejects with what it threw', async () => {
    const pool = fakePool({ acquired: true, released: true });
    await expect(
      createPgLoopLock(pool, 'alert_evaluation').runExclusive(() =>
        Promise.reject(new Error('EAI_AGAIN')),
      ),
    ).rejects.toThrow('EAI_AGAIN');
    expect(pool.clients[0]?.queries.map(([text]) => text)).toEqual([
      LOOP_LOCK_SQL.tryLock,
      LOOP_LOCK_SQL.unlock,
    ]);
    expect(pool.clients[0]?.releases).toEqual([false]);
  });

  it('destroys the connection when the unlock failed, so no pooled session keeps the lock', async () => {
    const failed = fakePool({ acquired: true, released: new Error('connection terminated') });
    expect(
      await createPgLoopLock(failed, 'ingest').runExclusive(() => Promise.resolve('ok')),
    ).toEqual({ acquired: true, value: 'ok' });
    expect(failed.clients[0]?.releases).toEqual([true]);

    // `false` means the session did not hold it — something else is wrong; same answer.
    const notHeld = fakePool({ acquired: true, released: false });
    await createPgLoopLock(notHeld, 'ingest').runExclusive(() => Promise.resolve('ok'));
    expect(notHeld.clients[0]?.releases).toEqual([true]);
  });

  it('hears the connection dropping mid-cycle instead of crashing, and destroys the client', async () => {
    const pool = fakePool({ acquired: true, released: true });
    await createPgLoopLock(pool, 'dispatch').runExclusive(() => {
      pool.clients[0]?.listener?.(new Error('Connection terminated unexpectedly'));
      return Promise.resolve('ok');
    });
    expect(pool.clients[0]?.releases).toEqual([true]);
    expect(pool.clients[0]?.listener).toBeNull();
  });

  it('rejects without running the body when the lock could not be asked for', async () => {
    const pool = fakePool({ acquired: new Error('ECONNREFUSED') });
    let ran = false;
    await expect(
      createPgLoopLock(pool, 'dispatch').runExclusive(() => {
        ran = true;
        return Promise.resolve(1);
      }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(ran).toBe(false);
    // Whether the server granted it before the error is unknown: the session goes.
    expect(pool.clients[0]?.releases).toEqual([true]);
  });

  it('closes its pool once, however often it is asked', async () => {
    const pool = fakePool({});
    const locks = createPgLoopLocks(pool);
    await Promise.all([locks.close(), locks.close()]);
    expect(pool.ended).toBe(1);
  });
});
