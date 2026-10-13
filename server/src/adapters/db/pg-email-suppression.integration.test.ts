/**
 * The SES feedback suppression against a real Postgres: that it stops every live email
 * subscription on the address — across accounts, pending ones included — and nothing
 * else (another address, a Telegram row, an already-revoked row, a pseudonymized
 * endpoint), that a redelivery stops nothing new and keeps the first instant, and that the
 * recipient resolver then refuses the subscription.
 *
 * Skipped when there is no Docker daemon, which is the normal state of a laptop here;
 * `FIRE_WATCH_REQUIRE_DOCKER=1` in CI turns that skip into a failure.
 */

import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgEmailSuppression } from './pg-email-suppression.js';
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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. The bounce ' +
      'suppression is only ever executed here, so skipping it in CI is a false green.',
  );
}

const NOW = Date.parse('2026-10-13T09:00:00Z');

describe.skipIf(!hasDocker)('the SES feedback suppression', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  async function account(): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    return rows[0]?.id ?? '';
  }

  async function subscription(
    accountId: string,
    channel: 'email' | 'telegram',
    endpoint: string,
    options: { readonly confirmed?: boolean; readonly revokedAt?: string } = {},
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO channel_subscriptions (account_id, channel, endpoint, confirmed_at, revoked_at)
       VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END, $5::timestamptz)
       RETURNING id`,
      [accountId, channel, endpoint, options.confirmed ?? true, options.revokedAt ?? null],
    );
    return rows[0]?.id ?? '';
  }

  async function revokedAt(id: string): Promise<number | null> {
    const { rows } = await db.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM channel_subscriptions WHERE id = $1',
      [id],
    );
    return rows[0]?.revoked_at?.getTime() ?? null;
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
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await container?.stop();
  });

  it('stops every live email subscription on the address, and only those', async () => {
    const first = await account();
    const second = await account();
    const confirmed = await subscription(first, 'email', 'bounced@example.com');
    const pending = await subscription(second, 'email', 'bounced@example.com', {
      confirmed: false,
    });
    const earlier = '2026-10-01T00:00:00Z';
    const alreadyRevoked = await subscription(first, 'email', 'bounced@example.com', {
      revokedAt: earlier,
    });
    const otherAddress = await subscription(first, 'email', 'fine@example.com');
    const telegram = await subscription(first, 'telegram', '123456789');
    const pseudonymized = await subscription(second, 'email', '');

    const suppressor = createPgEmailSuppression(db);
    expect(await suppressor.suppress('bounced@example.com', NOW)).toBe(2);

    expect(await revokedAt(confirmed)).toBe(NOW);
    expect(await revokedAt(pending)).toBe(NOW);
    expect(await revokedAt(alreadyRevoked)).toBe(Date.parse(earlier));
    expect(await revokedAt(otherAddress)).toBeNull();
    expect(await revokedAt(telegram)).toBeNull();
    expect(await revokedAt(pseudonymized)).toBeNull();
  });

  it('a redelivery stops nothing new and keeps the first instant', async () => {
    const id = await subscription(await account(), 'email', 'twice@example.com');
    const suppressor = createPgEmailSuppression(db);
    expect(await suppressor.suppress('twice@example.com', NOW)).toBe(1);
    expect(await suppressor.suppress('twice@example.com', NOW + 60_000)).toBe(0);
    expect(await revokedAt(id)).toBe(NOW);
  });

  it('an address on no subscription — a sign-in mail bounced — stops nothing', async () => {
    expect(await createPgEmailSuppression(db).suppress('nobody@example.com', NOW)).toBe(0);
  });

  it('matches the stored form exactly: no case folding in SQL', async () => {
    // Opt-in stores lowercase; a mixed-case row can only exist if that ever changes, and
    // then this test is the one that says so.
    const id = await subscription(await account(), 'email', 'Mixed@Example.com');
    expect(await createPgEmailSuppression(db).suppress('mixed@example.com', NOW)).toBe(0);
    expect(await revokedAt(id)).toBeNull();
  });

  it('the recipient resolver refuses a suppressed subscription', async () => {
    const accountId = await account();
    const subscriptionId = await subscription(accountId, 'email', 'resolve@example.com');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Vitosha', ST_GeogFromText('SRID=4326;POINT(23.28 42.58)'), 5000)
       RETURNING id`,
      [accountId],
    );
    const pair = { watchZoneId: rows[0]?.id ?? '', channelSubscriptionId: subscriptionId };
    const resolver = createPgRecipientResolver(db, { now: () => NOW });
    expect(await resolver.resolve(pair)).toMatchObject({ live: true });

    await createPgEmailSuppression(db).suppress('resolve@example.com', NOW);
    expect(await resolver.resolve(pair)).toEqual({
      live: false,
      reason: 'channel subscription was revoked',
    });
  });
});
