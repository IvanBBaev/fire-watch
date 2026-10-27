/**
 * The V2-C5 preferences store against a real Postgres (migration 034), run as the
 * runtime role: the first write and the conditional update, and — the point of the table —
 * that two devices writing from the same revision cannot both win, whether they race on
 * the first INSERT or on an UPDATE, and however many of them there are. Then the table's
 * own guards: the size bound, the erased-account trigger, and the cascade.
 *
 * Synthetic rows only. Skipped without a Docker daemon; `FIRE_WATCH_REQUIRE_DOCKER=1`
 * turns the skip into a failure so CI cannot go green by not running it.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ACCOUNT_PREFERENCES_SCHEMA } from '@fire-watch/contracts';

import {
  readAccountPreferences,
  writeAccountPreferences,
} from '../../core/preferences/account-preferences.js';
import { createPgAccountPreferencesStore } from './pg-account-preferences.js';

const execFileAsync = promisify(execFile);

const POSTGIS_IMAGE = 'postgis/postgis:16-3.4';
const APP_ROLE = 'fire_watch_app';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The preferences ' +
      'store only runs against Postgres, so skipping it in CI is a false green.',
  );
}

const AT = '2026-10-27T08:00:00.000Z';

function document(theme: 'light' | 'dark' | 'auto'): unknown {
  return { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: { theme } };
}

describe.skipIf(!hasDocker)('account preferences store', () => {
  let container: StartedPostgreSqlContainer;
  /** The migration owner: seeds accounts and inspects rows. */
  let db: Client;
  /** Runtime-role connections; enough of them that the racers really are concurrent. */
  let appPool: Pool;

  async function newAccount(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (timezone, email, email_verified_at)
       VALUES ('Europe/Sofia', $1, $2) RETURNING id`,
      [`prefs-${randomUUID()}@example.org`, AT],
    );
    return rows[0]?.id ?? '';
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
    appPool = new Pool({ connectionString: databaseUrl, max: 8 });
    appPool.on('connect', (client) => {
      void client.query(`SET ROLE ${APP_ROLE}`);
    });
  }, 300_000);

  afterAll(async () => {
    await appPool?.end();
    await db?.end();
    await container?.stop();
  });

  it('reads nothing stored as revision 0, then writes and reads back', async () => {
    const accountId = await newAccount();
    const store = createPgAccountPreferencesStore(appPool);
    await expect(readAccountPreferences(accountId, store)).resolves.toEqual({
      revision: 0,
      document: { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: {} },
    });
    await expect(store.write(accountId, document('dark'), 0, AT)).resolves.toBe(1);
    await expect(store.write(accountId, document('light'), 1, AT)).resolves.toBe(2);
    await expect(readAccountPreferences(accountId, store)).resolves.toEqual({
      revision: 2,
      document: document('light'),
    });
  });

  it('refuses a stale revision and a second first write without touching the row', async () => {
    const accountId = await newAccount();
    const store = createPgAccountPreferencesStore(appPool);
    await store.write(accountId, document('dark'), 0, AT);
    await expect(store.write(accountId, document('light'), 0, AT)).resolves.toBeNull();
    await expect(store.write(accountId, document('light'), 7, AT)).resolves.toBeNull();
    await expect(store.read(accountId)).resolves.toEqual({
      revision: 1,
      document: document('dark'),
    });
  });

  it('of eight devices racing the first write, exactly one wins', async () => {
    const accountId = await newAccount();
    const store = createPgAccountPreferencesStore(appPool);
    const themes = ['light', 'dark', 'auto', 'light', 'dark', 'auto', 'light', 'dark'] as const;
    const results = await Promise.all(
      themes.map((theme) => store.write(accountId, document(theme), 0, AT)),
    );
    expect(results.filter((revision) => revision === 1)).toHaveLength(1);
    expect(results.filter((revision) => revision === null)).toHaveLength(themes.length - 1);
    const stored = await store.read(accountId);
    expect(stored?.revision).toBe(1);
    expect(stored?.document).toEqual(document(themes[results.indexOf(1)] ?? 'auto'));
  });

  it('of eight devices racing an update from the same revision, exactly one wins', async () => {
    const accountId = await newAccount();
    const store = createPgAccountPreferencesStore(appPool);
    await store.write(accountId, document('auto'), 0, AT);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeAccountPreferences(
          { accountId, expectedRevision: 1, body: document(i % 2 === 0 ? 'light' : 'dark') },
          AT,
          store,
        ),
      ),
    );
    const written = results.filter((outcome) => outcome.kind === 'written');
    expect(written).toHaveLength(1);
    expect(results.filter((outcome) => outcome.kind === 'conflict')).toHaveLength(7);
    const winner = written[0];
    if (winner?.kind !== 'written') throw new Error('no winner');
    expect(winner.state.revision).toBe(2);
    await expect(readAccountPreferences(accountId, store)).resolves.toEqual(winner.state);
  });

  it('a loser that refetches and retries from the new revision then wins', async () => {
    const accountId = await newAccount();
    const store = createPgAccountPreferencesStore(appPool);
    await store.write(accountId, document('auto'), 0, AT);
    await store.write(accountId, document('dark'), 1, AT);
    await expect(store.write(accountId, document('light'), 1, AT)).resolves.toBeNull();
    const current = await readAccountPreferences(accountId, store);
    await expect(store.write(accountId, document('light'), current.revision, AT)).resolves.toBe(3);
  });

  it('bounds the stored document, whatever the route let through', async () => {
    const accountId = await newAccount();
    const store = createPgAccountPreferencesStore(appPool);
    const huge = { schema: ACCOUNT_PREFERENCES_SCHEMA, preferences: { pad: 'x'.repeat(9_000) } };
    await expect(store.write(accountId, huge, 0, AT)).rejects.toThrow(/account_preferences/);
    await expect(store.write(accountId, ['not', 'an', 'object'], 0, AT)).rejects.toThrow(
      /account_preferences/,
    );
  });

  it('refuses a write for an erased account, and goes with a deleted one', async () => {
    const erased = await newAccount();
    await db.query(
      `UPDATE accounts SET email = NULL, email_verified_at = NULL, deleted_at = $2 WHERE id = $1`,
      [erased, AT],
    );
    const store = createPgAccountPreferencesStore(appPool);
    await expect(store.write(erased, document('dark'), 0, AT)).rejects.toThrow();

    const deleted = await newAccount();
    await store.write(deleted, document('dark'), 0, AT);
    await db.query('DELETE FROM accounts WHERE id = $1', [deleted]);
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::integer AS n FROM account_preferences WHERE account_id = $1',
      [deleted],
    );
    expect(rows[0]?.n).toBe(0);
  });
});
