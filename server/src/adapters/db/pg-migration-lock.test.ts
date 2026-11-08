import { describe, expect, it } from 'vitest';

import {
  MIGRATION_LOCK_CLASS,
  MIGRATION_LOCK_SQL,
  withMigrationLock,
  type PgMigrationLockClient,
} from './pg-migration-lock.js';

function fakeClient(options: { failOn?: string } = {}) {
  const calls: string[] = [];
  const client: PgMigrationLockClient = {
    connect: () => {
      calls.push('connect');
      return Promise.resolve();
    },
    query: <Row extends Record<string, unknown>>(text: string) => {
      calls.push(text);
      if (options.failOn !== undefined && text.includes(options.failOn)) {
        return Promise.reject(new Error(`failed: ${text}`));
      }
      return Promise.resolve({ rows: [{ released: true }] as unknown as Row[] });
    },
    end: () => {
      calls.push('end');
      return Promise.resolve();
    },
    on: () => client,
  };
  return { client, calls };
}

describe('withMigrationLock', () => {
  it('takes a blocking, bounded session lock around the body and always ends the client', async () => {
    const { client, calls } = fakeClient();
    const result = await withMigrationLock(
      client,
      () => {
        calls.push('body');
        return Promise.resolve(42);
      },
      5_000,
    );
    expect(result).toBe(42);
    expect(calls).toEqual([
      'connect',
      'SET lock_timeout = 5000',
      MIGRATION_LOCK_SQL.lock,
      'body',
      MIGRATION_LOCK_SQL.unlock,
      'end',
    ]);
  });

  it('uses its own advisory class, apart from the worker loops', () => {
    expect(MIGRATION_LOCK_CLASS).toBe(7040);
    expect(MIGRATION_LOCK_SQL.lock).toContain('pg_advisory_lock(7040, 0)');
    expect(MIGRATION_LOCK_SQL.lock).not.toContain('try');
  });

  it('never runs the body when the lock is not granted in time', async () => {
    const { client, calls } = fakeClient({ failOn: 'pg_advisory_lock' });
    let ran = false;
    await expect(
      withMigrationLock(client, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(/pg_advisory_lock/);
    expect(ran).toBe(false);
    expect(calls.at(-1)).toBe('end');
  });

  it("reports the body's failure, not the unlock's, and still ends the session", async () => {
    const { client, calls } = fakeClient({ failOn: 'pg_advisory_unlock' });
    await expect(
      withMigrationLock(client, () => Promise.reject(new Error('dbmate exited 1'))),
    ).rejects.toThrow('dbmate exited 1');
    expect(calls.at(-1)).toBe('end');
  });

  it('refuses a non-positive timeout before connecting', async () => {
    const { client, calls } = fakeClient();
    await expect(withMigrationLock(client, () => Promise.resolve(), 0)).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});
