/**
 * Channel double opt-in (TASKS I3, migration 012) against a real Postgres: a token is
 * stored as a 32-byte hash and never as itself, confirms exactly once, expires, cannot
 * re-confirm a channel its owner unlinked; the per-address mail limit holds across
 * accounts; a Telegram link stores the chat id and nothing else; 012's CHECKs refuse a
 * non-numeric Telegram endpoint and a confirmation with two endings; and the resolver
 * treats a pending subscription as not dispatchable.
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

import type { ChannelOptInPolicy } from '../../core/channels/channel-opt-in.js';
import { CHANNEL_OPT_IN_POLICY } from '../../core/channels/opt-in-policy.js';
import type {
  ChannelConfirmationMailer,
  TelegramBotApi,
  TelegramLinkAck,
} from '../../core/ports/channel-opt-in-store.js';
import { epochMsFromIso } from '../../core/ports/clock.js';
import { createAuthTokens } from '../crypto/auth-tokens.js';
import { createPgChannelOptInFlows } from './pg-channel-opt-in.js';
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
    'FIRE_WATCH_REQUIRE_DOCKER=1 but no Docker daemon is reachable. Double opt-in is only ' +
      'ever executed against Postgres here, so skipping it in CI is a false green.',
  );
}

const AT = epochMsFromIso('2026-09-23T08:00:00Z');
const HOUR = 3_600_000;
const ARMED: ChannelOptInPolicy = {
  ...CHANNEL_OPT_IN_POLICY,
  telegram: { pendingTtlMs: HOUR, issuesPerWindow: 5, issueWindowMs: 24 * HOUR },
};

describe.skipIf(!hasDocker)('channel double opt-in', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  const mailed: { to: string; token: string }[] = [];
  const acks: { chatId: string; outcome: TelegramLinkAck }[] = [];
  const mailer: ChannelConfirmationMailer = {
    sendConfirmation(message) {
      mailed.push({ to: message.to, token: message.token });
      return Promise.resolve();
    },
  };
  const bot: TelegramBotApi = {
    acknowledgeLink(chatId, outcome) {
      acks.push({ chatId, outcome });
      return Promise.resolve();
    },
  };
  const flows = (policy: ChannelOptInPolicy = ARMED) =>
    createPgChannelOptInFlows(pool, { tokens: createAuthTokens(), mailer, bot, policy });

  async function newAccount(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO accounts (timezone) VALUES ('Europe/Sofia') RETURNING id",
    );
    return rows[0]?.id ?? '';
  }

  function lastMailedTo(address: string): string {
    const found = mailed.filter((m) => m.to === address).at(-1);
    if (found === undefined) throw new Error(`nothing was mailed to ${address}`);
    return found.token;
  }

  async function subscriptionRow(id: string) {
    const { rows } = await pool.query<{
      endpoint: string;
      confirmed_at: Date | null;
      revoked_at: Date | null;
    }>('SELECT endpoint, confirmed_at, revoked_at FROM channel_subscriptions WHERE id = $1', [id]);
    return rows[0];
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGIS_IMAGE).start();
    const databaseUrl = `${container.getConnectionUri()}?sslmode=disable`;
    await execFileAsync(dbmateBin, ['--no-dump-schema', 'up'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('stores only the hash, confirms once, then refuses the same token as used', async () => {
    const accountId = await newAccount();
    const requested = await flows().requestEmail({ accountId, email: 'once@example.org' }, AT);
    expect(requested.status).toBe('pending');
    const token = lastMailedTo('once@example.org');

    const { rows } = await pool.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM channel_confirmations WHERE account_id = $1',
      [accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash.length).toBe(32);
    expect(rows[0]?.token_hash.toString('utf8')).not.toContain(token);

    const confirmed = await flows().confirmEmail({ token }, AT + HOUR);
    expect((await subscriptionRow(confirmed.subscriptionId))?.confirmed_at).not.toBeNull();
    await expect(flows().confirmEmail({ token }, AT + 2 * HOUR)).rejects.toMatchObject({
      code: 'used',
    });
  });

  it('keeps a pending channel out of dispatch until it is confirmed', async () => {
    const accountId = await newAccount();
    const requested = await flows().requestEmail({ accountId, email: 'gate@example.org' }, AT);
    if (requested.status !== 'pending') throw new Error('expected a pending request');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO watch_zones (account_id, name, area, radius_m)
       VALUES ($1, 'Rila', ST_GeogFromText('SRID=4326;POINT(23.6 42.1)'), 5000) RETURNING id`,
      [accountId],
    );
    const pair = {
      accountId,
      watchZoneId: rows[0]?.id ?? '',
      channelSubscriptionId: requested.subscriptionId,
    };
    const resolver = createPgRecipientResolver(pool, { now: () => AT });
    expect(await resolver.resolve(pair)).toMatchObject({ live: false });

    await flows().confirmEmail({ token: lastMailedTo('gate@example.org') }, AT + HOUR);
    expect(await resolver.resolve(pair)).toMatchObject({ live: true });
  });

  it('refuses an expired token and one superseded by a re-send', async () => {
    const accountId = await newAccount();
    await flows().requestEmail({ accountId, email: 'late@example.org' }, AT);
    const first = lastMailedTo('late@example.org');
    await flows().requestEmail({ accountId, email: 'late@example.org' }, AT + HOUR);
    const second = lastMailedTo('late@example.org');

    await expect(flows().confirmEmail({ token: first }, AT + 2 * HOUR)).rejects.toMatchObject({
      code: 'superseded',
    });
    await expect(flows().confirmEmail({ token: second }, AT + 50 * HOUR)).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('holds the three-a-day limit per address across accounts', async () => {
    const address = 'limit@example.org';
    for (let i = 0; i < 3; i += 1) {
      const accountId = await newAccount();
      await flows().requestEmail({ accountId, email: address }, AT + i * HOUR);
    }
    const fourth = await newAccount();
    await expect(
      flows().requestEmail({ accountId: fourth, email: address }, AT + 4 * HOUR),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('cannot re-confirm a channel its owner unlinked, and unlinking scrubs the endpoint', async () => {
    const accountId = await newAccount();
    const requested = await flows().requestEmail({ accountId, email: 'gone@example.org' }, AT);
    if (requested.status !== 'pending') throw new Error('expected a pending request');
    await expect(
      flows().unlink({ accountId, subscriptionId: requested.subscriptionId }, AT + HOUR),
    ).resolves.toBe(true);
    await expect(
      flows().confirmEmail({ token: lastMailedTo('gone@example.org') }, AT + 2 * HOUR),
    ).rejects.toMatchObject({ code: 'revoked' });
    expect((await subscriptionRow(requested.subscriptionId))?.endpoint).toBe('');
  });

  it('links a Telegram chat holding only the chat id, confirmed, and answers a repeat as already linked', async () => {
    const accountId = await newAccount();
    const first = await flows().requestTelegramLink({ accountId }, AT);
    const linked = await flows().handleTelegramStart(
      { chatId: '777000111', token: first.token },
      AT,
    );
    expect(linked).toEqual({ outcome: 'linked', refusal: null, acknowledged: true });

    const { rows } = await pool.query<{ endpoint: string; confirmed_at: Date | null }>(
      "SELECT endpoint, confirmed_at FROM channel_subscriptions WHERE account_id = $1 AND channel = 'telegram'",
      [accountId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe('777000111');
    expect(rows[0]?.confirmed_at).not.toBeNull();

    const second = await flows().requestTelegramLink({ accountId }, AT + HOUR);
    expect(
      await flows().handleTelegramStart({ chatId: '777000111', token: second.token }, AT + HOUR),
    ).toMatchObject({ outcome: 'already_linked' });
    expect(
      await flows().handleTelegramStart({ chatId: '777000111', token: first.token }, AT + HOUR),
    ).toEqual({ outcome: 'refused', refusal: 'used', acknowledged: true });
  });

  it('refuses a Telegram link while the shipped policy leaves it unarmed', async () => {
    const accountId = await newAccount();
    await expect(
      flows(CHANNEL_OPT_IN_POLICY).requestTelegramLink({ accountId }, AT),
    ).rejects.toMatchObject({ code: 'unarmed' });
  });

  it('refuses a Telegram endpoint that is not a bare chat id, and a confirmation with two endings', async () => {
    const accountId = await newAccount();
    await expect(
      pool.query(
        "INSERT INTO channel_subscriptions (account_id, channel, endpoint) VALUES ($1, 'telegram', '@someone')",
        [accountId],
      ),
    ).rejects.toThrow(/channel_subscriptions_telegram_chat_id_only/);

    const requested = await flows().requestEmail({ accountId, email: 'ends@example.org' }, AT);
    if (requested.status !== 'pending') throw new Error('expected a pending request');
    await expect(
      pool.query(
        'UPDATE channel_confirmations SET consumed_at = now(), revoked_at = now() WHERE account_id = $1',
        [accountId],
      ),
    ).rejects.toThrow(/channel_confirmations_one_ending/);
  });
});
