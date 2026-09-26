import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STATEMENT_TIMEOUT_MS,
  QUERY_TIMEOUT_GRACE_MS,
  createPgPool,
  startupOptions,
  type PgPoolOptions,
} from './pg-pool.js';
import type { PgQueryable } from './pg-detection-store.js';

const OPTIONS: PgPoolOptions = {
  databaseUrl: 'postgres://fire_watch:hunter2@127.0.0.1:1/fire_watch',
  role: 'fire_watch_app',
  applicationName: 'fire-watch-test',
};

describe('startupOptions', () => {
  it('assumes the role in the startup packet, before any query can run', () => {
    expect(startupOptions('fire_watch_app')).toBe('-c role=fire_watch_app');
  });

  it('refuses a role that could carry a second setting', () => {
    // `options` is a space-separated list, so a space is not a broken identifier —
    // it is `-c role=x -c something_else=y`.
    expect(() => startupOptions('fire_watch_app -c log_statement=none')).toThrow(/identifier/);
    expect(() => startupOptions('"Fire Watch"')).toThrow(/identifier/);
    expect(() => startupOptions('')).toThrow(/identifier/);
  });
});

describe('createPgPool', () => {
  it('is the store’s dependency without the store knowing about pg', async () => {
    const pool = createPgPool(OPTIONS);
    // A compile-time assertion, not a runtime one: the port stays the narrow slice of
    // `pg` the adapter actually uses.
    const queryable: PgQueryable = pool;

    expect(typeof queryable.query).toBe('function');
    await pool.end();
  });

  it('does not connect until something asks it to', async () => {
    // The URL above points at a closed port. Constructing the pool must therefore be
    // safe — the CLI reads its config, builds its wiring, and only then reaches out.
    const pool = createPgPool(OPTIONS);

    expect(pool.totalCount).toBe(0);
    await pool.end();
  });

  it('bounds a statement so a wedged query cannot outlive the cycle', async () => {
    const pool = createPgPool(OPTIONS);

    expect(pool.options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(pool.options.options).toBe('-c role=fire_watch_app');
    expect(pool.options.application_name).toBe('fire-watch-test');
    await pool.end();
  });

  it('bounds the wait on a server that cannot answer, just behind its own timeout', async () => {
    const pool = createPgPool({ ...OPTIONS, statementTimeoutMs: 1_000 });

    // statement_timeout is the server's; a paused or partitioned server never enforces it.
    expect(pool.options.query_timeout).toBe(1_000 + QUERY_TIMEOUT_GRACE_MS);
    await pool.end();
  });

  it('takes an explicit read timeout, and sets none when statements are unbounded', async () => {
    const explicit = createPgPool({ ...OPTIONS, queryTimeoutMs: 5_000 });
    const unbounded = createPgPool({ ...OPTIONS, statementTimeoutMs: 0 });

    expect(explicit.options.query_timeout).toBe(5_000);
    expect(unbounded.options.query_timeout).toBeUndefined();
    await Promise.all([explicit.end(), unbounded.end()]);
  });

  it('opens one connection by default, which is what a sequential cycle needs', async () => {
    const pool = createPgPool(OPTIONS);

    expect(pool.options.max).toBe(1);
    await pool.end();
  });

  it('survives a dropped idle connection instead of ending the process', async () => {
    // `pg` emits 'error' on an idle client the network dropped; with no listener that is
    // an unhandled event, and the cycle that already succeeded is reported as a crash.
    const pool = createPgPool(OPTIONS);

    expect(pool.listenerCount('error')).toBe(1);
    await pool.end();
  });
});
