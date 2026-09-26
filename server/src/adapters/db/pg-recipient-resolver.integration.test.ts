/**
 * A1.9's liveness re-check against a real Postgres: that the one statement sees a soft
 * deletion on either side of the zone, a revocation, a pending (unconfirmed) subscription
 * and a pseudonymized endpoint, that a
 * subscription borrowed from another account throws rather than resolves, and that a
 * prune stamps `revoked_at` once and keeps the first instant.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgRecipientResolver } from './pg-recipient-resolver.js';

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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The liveness re-check ' +
      'is only ever executed here, so skipping it in CI is a false green.',
  );
}

const NOW = Date.parse('2026-08-02T11:30:30Z');

interface Pair {
  readonly accountId: string;
  readonly watchZoneId: string;
  readonly channelSubscriptionId: string;
}

describe.skipIf(!hasDocker)('the liveness re-check', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  /**
   * A fresh account with one zone and one push subscription, so no test sees another's.
   * Confirmed unless asked otherwise: double opt-in (migration 012) is part of liveness.
   */
  async function seedPair(
    endpoint = 'https://example.invalid/push/not-a-real-endpoint',
    confirmed = true,
  ): Promise<Pair> {
    const { rows: accounts } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    const accountId = accounts[0]?.id ?? '';
    const { rows: subscriptions } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint, confirmed_at)
       VALUES ($1, 'push', $2, CASE WHEN $3::boolean THEN now() END) RETURNING id`,
      [accountId, endpoint, confirmed],
    );
    const { rows: zones } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Vitosha', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000)
       RETURNING id`,
      [accountId],
    );
    return {
      accountId,
      watchZoneId: zones[0]?.id ?? '',
      channelSubscriptionId: subscriptions[0]?.id ?? '',
    };
  }

  const resolver = () => createPgRecipientResolver(db, { now: () => NOW });

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;

    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    db = new Client({ connectionString: databaseUrl });
    await db.connect();
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('resolves a live pair to its endpoint and the account time zone', async () => {
    const pair = await seedPair();
    expect(await resolver().resolve(pair)).toEqual({
      live: true,
      endpoint: 'https://example.invalid/push/not-a-real-endpoint',
      channel: 'push',
      timeZone: 'Europe/Sofia',
    });
  });

  it('sees a soft-deleted zone and a soft-deleted account', async () => {
    const zoneGone = await seedPair();
    await db.query('UPDATE watch_zones SET deleted_at = now() WHERE id = $1', [
      zoneGone.watchZoneId,
    ]);
    const accountGone = await seedPair();
    await db.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [accountGone.accountId]);

    expect(await resolver().resolve(zoneGone)).toEqual({
      live: false,
      reason: 'watch zone was deleted',
    });
    expect(await resolver().resolve(accountGone)).toEqual({
      live: false,
      reason: 'account was deleted',
    });
  });

  it('tells a missing zone from a missing subscription', async () => {
    const pair = await seedPair();
    expect(await resolver().resolve({ ...pair, watchZoneId: randomUUID() })).toEqual({
      live: false,
      reason: 'watch zone is gone',
    });
    expect(await resolver().resolve({ ...pair, channelSubscriptionId: randomUUID() })).toEqual({
      live: false,
      reason: 'channel subscription is gone',
    });
  });

  it('never resolves a subscription that is still pending confirmation', async () => {
    const pair = await seedPair(undefined, false);
    expect(await resolver().resolve(pair)).toEqual({
      live: false,
      reason: 'channel subscription is not confirmed',
    });
  });

  it('treats a pseudonymized endpoint as no endpoint', async () => {
    // `endpoint` is NOT NULL, so A1.3's pseudonymization can only empty it.
    const pair = await seedPair('');
    expect(await resolver().resolve(pair)).toEqual({
      live: false,
      reason: 'channel subscription has no endpoint',
    });
  });

  it("throws on another account's subscription", async () => {
    const mine = await seedPair();
    const theirs = await seedPair();
    await expect(
      resolver().resolve({
        watchZoneId: mine.watchZoneId,
        channelSubscriptionId: theirs.channelSubscriptionId,
      }),
    ).rejects.toThrow(/different account/);
  });

  it('prunes once: a second prune keeps the first instant, and the pair reads revoked', async () => {
    const pair = await seedPair();
    await resolver().applyDisposition(pair.channelSubscriptionId, 'prune');
    await createPgRecipientResolver(db, { now: () => NOW + 60_000 }).applyDisposition(
      pair.channelSubscriptionId,
      'reprompt',
    );

    const { rows } = await db.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM channel_subscriptions WHERE id = $1',
      [pair.channelSubscriptionId],
    );
    expect(rows[0]?.revoked_at?.getTime()).toBe(NOW);
    expect(await resolver().resolve(pair)).toEqual({
      live: false,
      reason: 'channel subscription was revoked',
    });
  });

  it('leaves a kept subscription live', async () => {
    const pair = await seedPair();
    await resolver().applyDisposition(pair.channelSubscriptionId, 'keep');
    expect(await resolver().resolve(pair)).toMatchObject({ live: true });
  });
});
