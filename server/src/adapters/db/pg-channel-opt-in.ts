/**
 * Channel double opt-in over Postgres (TASKS I3; ADR-004 D6, D8; 05 §5.5.3; migration 012):
 * the confirmation store, the subscription writer, and the flows from
 * `core/channels/channel-opt-in.ts` bound to them with the transactions they need.
 *
 * **Which flows are transactions, and why.**
 *
 *   * Requesting a confirmation (email or Telegram): `lockScope` takes a transaction-scoped
 *     advisory lock on the address (or the account, for Telegram), so "count the window,
 *     supersede, insert" cannot interleave with a second request — without it two
 *     concurrent requests would each count two and each insert a third. The mail is sent
 *     inside the transaction: if the mailer throws, the rows roll back and the attempt does
 *     not use up one of the address's three.
 *   * Confirming and completing a link: consume, then confirm or insert the subscription —
 *     one unit, so a consumed token always has its confirmed subscription and a refusal
 *     after the consume (the channel was unlinked meanwhile) rolls the consume back.
 *   * The Telegram acknowledgement goes out **after** the commit, best-effort.
 *   * Unlinking: revoke the subscription and its open confirmations together.
 *
 * Tokens reach this module as SHA-256 hashes only (`bytea`, 32 bytes, CHECKed by 012).
 *
 * **Constructed by `app/auth-wiring.ts`, unarmed.** The mailer and the Telegram Bot API
 * have no implementation (sender, subdomain, confirmation copy, bot identity are founder
 * decisions): the wiring hands in ports that refuse, and short-circuits `requestEmail` to
 * an `unarmed` refusal, so only confirm and unlink ever reach these transactions.
 */

import {
  acknowledgeTelegramLink,
  ChannelOptInRefusal,
  completeTelegramLink,
  confirmEmailChannel,
  requestEmailChannel,
  requestTelegramLink,
  unlinkChannel,
  type ChannelOptInPolicy,
  type ChannelOptInRefusalCode,
  type EmailChannelRequestResult,
} from '../../core/channels/channel-opt-in.js';
import { CHANNEL_OPT_IN_POLICY } from '../../core/channels/opt-in-policy.js';
import type { TelegramStart } from '../../core/channels/telegram-start.js';
import type { AuthTokens } from '../../core/ports/auth-stores.js';
import type {
  ChannelConfirmationMailer,
  ChannelConfirmationStore,
  ChannelSubscriptionWriter,
  OptInChannel,
  StoredChannelConfirmation,
  TelegramBotApi,
  TelegramLinkAck,
} from '../../core/ports/channel-opt-in-store.js';
import type { EpochMs } from '../../core/ports/clock.js';
import { boolean, epochMs, field, string } from './pg-rows.js';

/** The slice of `pg` this module uses. Redeclared rather than imported. */
export interface PgOptInQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface PgOptInClient extends PgOptInQueryable {
  release(): void;
}

export interface PgOptInPool extends PgOptInQueryable {
  connect(): Promise<PgOptInClient>;
}

/** The advisory-lock class for confirmation issuance; sign-in's is 7007. */
export const OPT_IN_LOCK_CLASS = 7012;

const LOCK_SCOPE = `SELECT pg_advisory_xact_lock(${OPT_IN_LOCK_CLASS}, hashtext($1::text))`;

/**
 * Per address across accounts, plus the requesting account's own email confirmations —
 * the account term survives an unlink scrubbing the endpoint (see `IssueScope`).
 */
const ISSUED_SINCE_EMAIL = `
SELECT c.issued_at
FROM channel_confirmations c
LEFT JOIN channel_subscriptions s ON s.id = c.channel_subscription_id
WHERE c.channel = 'email'
  AND c.issued_at >= $3::timestamptz
  AND (s.endpoint = $1::text OR c.account_id = $2::uuid)
ORDER BY c.issued_at`;

const ISSUED_SINCE_TELEGRAM = `
SELECT issued_at
FROM channel_confirmations
WHERE channel = 'telegram' AND account_id = $1::uuid AND issued_at >= $2::timestamptz
ORDER BY issued_at`;

const OPEN = 'consumed_at IS NULL AND superseded_at IS NULL AND revoked_at IS NULL';

const SUPERSEDE_FOR_SUBSCRIPTION = `
UPDATE channel_confirmations
SET superseded_at = $2::timestamptz
WHERE channel_subscription_id = $1::uuid AND ${OPEN}`;

const SUPERSEDE_TELEGRAM_FOR_ACCOUNT = `
UPDATE channel_confirmations
SET superseded_at = $2::timestamptz
WHERE account_id = $1::uuid AND channel = 'telegram' AND ${OPEN}`;

const INSERT_CONFIRMATION = `
INSERT INTO channel_confirmations
  (id, account_id, channel, channel_subscription_id, token_hash, issued_at, expires_at)
VALUES ($1::uuid, $2::uuid, $3::text, $4::uuid, $5::bytea, $6::timestamptz, $7::timestamptz)`;

const FIND_CONFIRMATION = `
SELECT
  c.id::text AS id,
  c.account_id::text AS account_id,
  c.channel,
  c.channel_subscription_id::text AS channel_subscription_id,
  c.issued_at,
  c.expires_at,
  c.consumed_at,
  c.superseded_at,
  c.revoked_at,
  (a.deleted_at IS NOT NULL) AS account_deleted
FROM channel_confirmations c
JOIN accounts a ON a.id = c.account_id
WHERE c.token_hash = $1::bytea`;

/** The conditions repeat the policy's on purpose: the write itself is the single-use guard. */
const CONSUME_CONFIRMATION = `
UPDATE channel_confirmations
SET consumed_at = $2::timestamptz,
    channel_subscription_id = COALESCE($3::uuid, channel_subscription_id)
WHERE id = $1::uuid AND ${OPEN} AND expires_at > $2::timestamptz`;

const REVOKE_OPEN_FOR_SUBSCRIPTION = `
UPDATE channel_confirmations
SET revoked_at = $2::timestamptz
WHERE channel_subscription_id = $1::uuid AND ${OPEN}`;

const FIND_LIVE_SUBSCRIPTION = `
SELECT id::text AS id, confirmed_at
FROM channel_subscriptions
WHERE account_id = $1::uuid AND channel = $2::text AND endpoint = $3::text AND revoked_at IS NULL
ORDER BY confirmed_at IS NULL, created_at
LIMIT 1`;

const INSERT_SUBSCRIPTION = `
INSERT INTO channel_subscriptions (id, account_id, channel, endpoint, created_at, confirmed_at)
VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::timestamptz, $6::timestamptz)`;

const CONFIRM_SUBSCRIPTION = `
UPDATE channel_subscriptions
SET confirmed_at = $2::timestamptz
WHERE id = $1::uuid AND confirmed_at IS NULL AND revoked_at IS NULL`;

/** Unlinking scrubs the endpoint: a chat id is kept "until the channel is unlinked" (05 §5.3.3). */
const REVOKE_SUBSCRIPTION = `
UPDATE channel_subscriptions
SET revoked_at = $3::timestamptz, endpoint = ''
WHERE id = $1::uuid AND account_id = $2::uuid AND revoked_at IS NULL`;

/** Exported for the tests that assert the statements' shape rather than their effect. */
export const OPT_IN_SQL = {
  lockScope: LOCK_SCOPE,
  issuedSinceEmail: ISSUED_SINCE_EMAIL,
  issuedSinceTelegram: ISSUED_SINCE_TELEGRAM,
  supersedeForSubscription: SUPERSEDE_FOR_SUBSCRIPTION,
  supersedeTelegramForAccount: SUPERSEDE_TELEGRAM_FOR_ACCOUNT,
  insertConfirmation: INSERT_CONFIRMATION,
  findConfirmation: FIND_CONFIRMATION,
  consumeConfirmation: CONSUME_CONFIRMATION,
  revokeOpenForSubscription: REVOKE_OPEN_FOR_SUBSCRIPTION,
  findLiveSubscription: FIND_LIVE_SUBSCRIPTION,
  insertSubscription: INSERT_SUBSCRIPTION,
  confirmSubscription: CONFIRM_SUBSCRIPTION,
  revokeSubscription: REVOKE_SUBSCRIPTION,
} as const;

export function createPgChannelConfirmationStore(db: PgOptInQueryable): ChannelConfirmationStore {
  return {
    async lockScope(scope) {
      const key =
        scope.channel === 'email' ? `email:${scope.address}` : `telegram:${scope.accountId}`;
      await db.query(LOCK_SCOPE, [key]);
    },
    async issuedSince(scope, sinceIso) {
      const result =
        scope.channel === 'email'
          ? await db.query(ISSUED_SINCE_EMAIL, [scope.address, scope.accountId, sinceIso])
          : await db.query(ISSUED_SINCE_TELEGRAM, [scope.accountId, sinceIso]);
      return result.rows.map((row) => epochMs(field(row, 'issued_at'), 'issued_at'));
    },
    async supersedeOpen(target, atIso) {
      if ('channelSubscriptionId' in target) {
        await db.query(SUPERSEDE_FOR_SUBSCRIPTION, [target.channelSubscriptionId, atIso]);
      } else {
        await db.query(SUPERSEDE_TELEGRAM_FOR_ACCOUNT, [target.accountId, atIso]);
      }
    },
    async insert(confirmation) {
      const result = await db.query(INSERT_CONFIRMATION, [
        confirmation.id,
        confirmation.accountId,
        confirmation.channel,
        confirmation.channelSubscriptionId,
        Buffer.from(confirmation.tokenHash),
        confirmation.issuedAtIso,
        confirmation.expiresAtIso,
      ]);
      if (result.rowCount !== 1) {
        throw new Error('channel confirmation insert did not write exactly one row');
      }
    },
    async findByTokenHash(tokenHash) {
      const result = await db.query(FIND_CONFIRMATION, [Buffer.from(tokenHash)]);
      const [row] = result.rows;
      return row === undefined ? null : decodeConfirmation(row);
    },
    async consume(id, atIso, channelSubscriptionId) {
      const result = await db.query(CONSUME_CONFIRMATION, [id, atIso, channelSubscriptionId]);
      return result.rowCount === 1;
    },
    async revokeOpenForSubscription(channelSubscriptionId, atIso) {
      const result = await db.query(REVOKE_OPEN_FOR_SUBSCRIPTION, [channelSubscriptionId, atIso]);
      return result.rowCount ?? 0;
    },
  };
}

export function createPgChannelSubscriptionWriter(db: PgOptInQueryable): ChannelSubscriptionWriter {
  return {
    async findLive(accountId, channel, endpoint) {
      const result = await db.query(FIND_LIVE_SUBSCRIPTION, [accountId, channel, endpoint]);
      const [row] = result.rows;
      if (row === undefined) return null;
      return {
        id: string(field(row, 'id'), 'id'),
        confirmedAt: nullableEpochMs(field(row, 'confirmed_at'), 'confirmed_at'),
      };
    },
    async insert(subscription) {
      const result = await db.query(INSERT_SUBSCRIPTION, [
        subscription.id,
        subscription.accountId,
        subscription.channel,
        subscription.endpoint,
        subscription.createdAtIso,
        subscription.confirmedAtIso,
      ]);
      if (result.rowCount !== 1) {
        throw new Error('channel subscription insert did not write exactly one row');
      }
    },
    async confirm(id, atIso) {
      const result = await db.query(CONFIRM_SUBSCRIPTION, [id, atIso]);
      return result.rowCount === 1;
    },
    async revoke(id, accountId, atIso) {
      const result = await db.query(REVOKE_SUBSCRIPTION, [id, accountId, atIso]);
      return result.rowCount === 1;
    },
  };
}

// ── The flows, with their transactions ───────────────────────────────────────────────

export interface TelegramStartHandled {
  readonly outcome: TelegramLinkAck;
  /** Why a `/start` was refused — for the log, never for the chat. */
  readonly refusal: ChannelOptInRefusalCode | null;
  /** Whether the acknowledgement reached the Bot API. */
  readonly acknowledged: boolean;
}

export interface PgChannelOptInFlows {
  requestEmail(
    request: { readonly accountId: string; readonly email: string },
    at: EpochMs,
  ): Promise<EmailChannelRequestResult>;
  confirmEmail(
    request: { readonly token: string },
    at: EpochMs,
  ): Promise<{ readonly subscriptionId: string }>;
  requestTelegramLink(
    request: { readonly accountId: string },
    at: EpochMs,
  ): Promise<{ readonly token: string; readonly expiresAt: EpochMs }>;
  handleTelegramStart(start: TelegramStart, at: EpochMs): Promise<TelegramStartHandled>;
  unlink(
    request: { readonly accountId: string; readonly subscriptionId: string },
    at: EpochMs,
  ): Promise<boolean>;
}

export function createPgChannelOptInFlows(
  pool: PgOptInPool,
  options: {
    readonly tokens: AuthTokens;
    readonly mailer: ChannelConfirmationMailer;
    readonly bot: TelegramBotApi;
    readonly policy?: ChannelOptInPolicy;
  },
): PgChannelOptInFlows {
  const policy = options.policy ?? CHANNEL_OPT_IN_POLICY;
  const depsOn = (client: PgOptInClient) => ({
    confirmations: createPgChannelConfirmationStore(client),
    subscriptions: createPgChannelSubscriptionWriter(client),
    tokens: options.tokens,
  });
  return {
    requestEmail: (request, at) =>
      inTransaction(pool, (client) =>
        requestEmailChannel(request, at, { ...depsOn(client), mailer: options.mailer }, policy),
      ),
    confirmEmail: (request, at) =>
      inTransaction(pool, (client) => confirmEmailChannel(request, at, depsOn(client))),
    requestTelegramLink: (request, at) =>
      inTransaction(pool, (client) => requestTelegramLink(request, at, depsOn(client), policy)),
    async handleTelegramStart(start, at) {
      let outcome: TelegramLinkAck;
      let refusal: ChannelOptInRefusalCode | null = null;
      try {
        const completed = await inTransaction(pool, (client) =>
          completeTelegramLink(start, at, depsOn(client)),
        );
        outcome = completed.outcome;
      } catch (error) {
        if (!(error instanceof ChannelOptInRefusal)) throw error;
        outcome = 'refused';
        refusal = error.code;
      }
      const acknowledged = await acknowledgeTelegramLink(options.bot, start.chatId, outcome);
      return { outcome, refusal, acknowledged };
    },
    unlink: (request, at) =>
      inTransaction(pool, (client) => unlinkChannel(request, at, depsOn(client))),
  };
}

/** Same shape as `pg-auth.ts`: ROLLBACK's own failure never masks the original. */
async function inTransaction<T>(
  pool: PgOptInPool,
  work: (client: PgOptInClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function nullableEpochMs(value: unknown, name: string): EpochMs | null {
  return value === null ? null : epochMs(value, name);
}

const CHANNELS: readonly OptInChannel[] = ['email', 'telegram', 'push'];

function channel(value: unknown): OptInChannel {
  const found = CHANNELS.find((candidate) => candidate === value);
  if (found === undefined) throw new Error('channel_confirmations.channel is not a known channel');
  return found;
}

function decodeConfirmation(row: Record<string, unknown>): StoredChannelConfirmation {
  const subscriptionId = field(row, 'channel_subscription_id');
  return {
    id: string(field(row, 'id'), 'id'),
    accountId: string(field(row, 'account_id'), 'account_id'),
    channel: channel(field(row, 'channel')),
    channelSubscriptionId:
      subscriptionId === null ? null : string(subscriptionId, 'channel_subscription_id'),
    issuedAt: epochMs(field(row, 'issued_at'), 'issued_at'),
    expiresAt: epochMs(field(row, 'expires_at'), 'expires_at'),
    consumedAt: nullableEpochMs(field(row, 'consumed_at'), 'consumed_at'),
    supersededAt: nullableEpochMs(field(row, 'superseded_at'), 'superseded_at'),
    revokedAt: nullableEpochMs(field(row, 'revoked_at'), 'revoked_at'),
    accountDeleted: boolean(field(row, 'account_deleted'), 'account_deleted'),
  };
}
