/**
 * The channel double-opt-in flows (TASKS I3; ADR-004 D6, D8 as amended by A16; 05 §5.3.3,
 * §5.5.3; migration 012): add an email channel pending and mail its confirmation, confirm
 * it, issue a Telegram deep link, complete that link from the bot's `/start`, unlink.
 *
 * Each flow is a plain sequence over `ports/channel-opt-in-store.ts`. The pg adapter
 * (`adapters/db/pg-channel-opt-in.ts`) runs each one inside a single transaction; nothing
 * here knows that, and nothing here reads a clock — `at` is always passed in.
 *
 * **Dispatchability is not decided here.** These flows only ever *write* `confirmed_at`;
 * the recipient resolver reads it on every send, and a pending row is never live. So a
 * flow that fails half-way can at worst leave a channel pending — never one that sends.
 *
 * **What a caller learns.** Refusals carry a code and nothing else: no address, no token,
 * no chat id. A Telegram `/start` is acknowledged to the chat with one of three outcomes
 * and no reason, so the bot is not an oracle for which tokens exist.
 */

import { normalizeEmail } from '../auth/auth-policy.js';
import type { AuthTokens } from '../ports/auth-stores.js';
import type {
  ChannelConfirmationMailer,
  ChannelConfirmationStore,
  ChannelSubscriptionWriter,
  OptInChannel,
  TelegramBotApi,
  TelegramLinkAck,
} from '../ports/channel-opt-in-store.js';
import { isoFromEpochMs, type EpochMs } from '../ports/clock.js';
import {
  CHANNEL_OPT_IN_POLICY,
  decideConfirmationIssue,
  evaluateConfirmation,
  type ChannelOptInRule,
  type ConfirmationRefusal,
} from './opt-in-policy.js';
import type { TelegramStart } from './telegram-start.js';

export type ChannelOptInRefusalCode =
  'invalid_email' | 'unarmed' | 'rate_limited' | ConfirmationRefusal;

/** A refusal the route maps to a problem document. Messages are literals only. */
export class ChannelOptInRefusal extends Error {
  readonly code: ChannelOptInRefusalCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ChannelOptInRefusalCode, retryAfterSeconds?: number) {
    super(`channel opt-in refused: ${code}`);
    this.name = 'ChannelOptInRefusal';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ChannelOptInDeps {
  readonly confirmations: ChannelConfirmationStore;
  readonly subscriptions: ChannelSubscriptionWriter;
  readonly tokens: AuthTokens;
}

/** The policy is injectable so tests (and a later armed config) can pass their own. */
export type ChannelOptInPolicy = Readonly<Record<OptInChannel, ChannelOptInRule>>;

function issueOrRefuse(rule: ChannelOptInRule, recent: readonly EpochMs[], at: EpochMs): EpochMs {
  const decision = decideConfirmationIssue(rule, recent, at);
  if (decision.allowed) return decision.expiresAt;
  if (decision.reason === 'unarmed') throw new ChannelOptInRefusal('unarmed');
  throw new ChannelOptInRefusal('rate_limited', decision.retryAfterSeconds);
}

// ── Email ────────────────────────────────────────────────────────────────────────────

export type EmailChannelRequestResult =
  | { readonly status: 'already_confirmed'; readonly subscriptionId: string }
  | { readonly status: 'pending'; readonly subscriptionId: string; readonly expiresAt: EpochMs };

/**
 * Adds (or re-sends) an email channel for a signed-in account. The order is the rule: lock
 * the address, count its window (05 §5.5.3: three a day), then reuse or insert the pending
 * subscription, supersede its open confirmation, insert the new one, and only then mail —
 * inside the adapter's transaction a mail failure rolls the rows back and does not use up
 * one of the address's three.
 *
 * An address the account has already confirmed is answered `already_confirmed` without a
 * mail and without counting: re-confirming a live channel is a no-op, not a new consent.
 */
export async function requestEmailChannel(
  request: { readonly accountId: string; readonly email: string },
  at: EpochMs,
  deps: ChannelOptInDeps & { readonly mailer: ChannelConfirmationMailer },
  policy: ChannelOptInPolicy = CHANNEL_OPT_IN_POLICY,
): Promise<EmailChannelRequestResult> {
  const email = normalizeEmail(request.email);
  if (email === null) throw new ChannelOptInRefusal('invalid_email');

  const rule = policy.email;
  const scope = { channel: 'email', address: email, accountId: request.accountId } as const;
  await deps.confirmations.lockScope(scope);

  const live = await deps.subscriptions.findLive(request.accountId, 'email', email);
  if (live !== null && live.confirmedAt !== null) {
    return { status: 'already_confirmed', subscriptionId: live.id };
  }

  const recent = await deps.confirmations.issuedSince(
    scope,
    isoFromEpochMs(at - rule.issueWindowMs),
  );
  const expiresAt = issueOrRefuse(rule, recent, at);

  const atIso = isoFromEpochMs(at);
  let subscriptionId: string;
  if (live === null) {
    subscriptionId = deps.tokens.newId();
    await deps.subscriptions.insert({
      id: subscriptionId,
      accountId: request.accountId,
      channel: 'email',
      endpoint: email,
      createdAtIso: atIso,
      confirmedAtIso: null,
    });
  } else {
    subscriptionId = live.id;
    await deps.confirmations.supersedeOpen({ channelSubscriptionId: subscriptionId }, atIso);
  }

  const minted = deps.tokens.mint();
  const expiresAtIso = isoFromEpochMs(expiresAt);
  await deps.confirmations.insert({
    id: deps.tokens.newId(),
    accountId: request.accountId,
    channel: 'email',
    channelSubscriptionId: subscriptionId,
    tokenHash: minted.hash,
    issuedAtIso: atIso,
    expiresAtIso,
  });
  await deps.mailer.sendConfirmation({ to: email, token: minted.token, expiresAtIso });
  return { status: 'pending', subscriptionId, expiresAt };
}

/**
 * Consumes an email confirmation token and confirms its subscription. Consume first: the
 * conditional write is the single-use guard, so of two concurrent presentations exactly
 * one proceeds. A subscription unlinked in the meantime refuses `revoked`, and the throw
 * rolls the consume back.
 */
export async function confirmEmailChannel(
  request: { readonly token: string },
  at: EpochMs,
  deps: ChannelOptInDeps,
): Promise<{ readonly subscriptionId: string }> {
  const hash = deps.tokens.hash(request.token);
  if (hash === null) throw new ChannelOptInRefusal('unknown');
  const found = await deps.confirmations.findByTokenHash(hash);
  const refusal = evaluateConfirmation(found, 'email', at);
  if (refusal !== null) throw new ChannelOptInRefusal(refusal);
  // Both unreachable (evaluateConfirmation answers `unknown` for null; 012's CHECK makes
  // an email confirmation name its subscription); refusing keeps the types honest.
  if (found === null || found.channelSubscriptionId === null) {
    throw new ChannelOptInRefusal('unknown');
  }
  const subscriptionId = found.channelSubscriptionId;

  const atIso = isoFromEpochMs(at);
  if (!(await deps.confirmations.consume(found.id, atIso, null))) {
    throw new ChannelOptInRefusal('used');
  }
  if (!(await deps.subscriptions.confirm(subscriptionId, atIso))) {
    throw new ChannelOptInRefusal('revoked');
  }
  return { subscriptionId };
}

// ── Telegram ─────────────────────────────────────────────────────────────────────────

/**
 * Issues a deep-link token for the signed-in account. The adapter builds
 * `https://t.me/<bot>?start=<token>`; the bot's name is a founder decision. While the
 * Telegram rule is unarmed (no TTL, no re-send limit decided) this always refuses
 * `unarmed`. Issuing supersedes the account's still-open links: one live link at a time.
 */
export async function requestTelegramLink(
  request: { readonly accountId: string },
  at: EpochMs,
  deps: ChannelOptInDeps,
  policy: ChannelOptInPolicy = CHANNEL_OPT_IN_POLICY,
): Promise<{ readonly token: string; readonly expiresAt: EpochMs }> {
  const rule = policy.telegram;
  const scope = { channel: 'telegram', accountId: request.accountId } as const;
  await deps.confirmations.lockScope(scope);
  const recent = await deps.confirmations.issuedSince(
    scope,
    isoFromEpochMs(at - rule.issueWindowMs),
  );
  const expiresAt = issueOrRefuse(rule, recent, at);

  const atIso = isoFromEpochMs(at);
  await deps.confirmations.supersedeOpen(
    { accountId: request.accountId, channel: 'telegram' },
    atIso,
  );
  const minted = deps.tokens.mint();
  await deps.confirmations.insert({
    id: deps.tokens.newId(),
    accountId: request.accountId,
    channel: 'telegram',
    channelSubscriptionId: null,
    tokenHash: minted.hash,
    issuedAtIso: atIso,
    expiresAtIso: isoFromEpochMs(expiresAt),
  });
  return { token: minted.token, expiresAt };
}

export interface CompletedTelegramLink {
  readonly outcome: Exclude<TelegramLinkAck, 'refused'>;
  readonly subscriptionId: string;
}

/**
 * Completes a link from a parsed `/start` (`parseTelegramStart`). The chat id is the only
 * thing taken from the update, and it becomes the subscription's endpoint — confirmed in
 * the same transaction, because the `/start` from that private chat *is* the confirmation
 * (05 §5.5.3: linking is user-initiated from the bot side).
 *
 *   * The account already has this chat linked and confirmed → the token is consumed and
 *     the answer is `already_linked`; no second row.
 *   * It has the chat as a pending row (one that predates migration 012) → that row is
 *     confirmed rather than duplicated.
 *   * Otherwise a confirmed subscription is inserted and the token consumed pointing at it.
 *
 * Refusals throw {@link ChannelOptInRefusal}; the throw rolls back any insert.
 */
export async function completeTelegramLink(
  start: TelegramStart,
  at: EpochMs,
  deps: ChannelOptInDeps,
): Promise<CompletedTelegramLink> {
  const hash = deps.tokens.hash(start.token);
  if (hash === null) throw new ChannelOptInRefusal('unknown');
  const found = await deps.confirmations.findByTokenHash(hash);
  const refusal = evaluateConfirmation(found, 'telegram', at);
  if (refusal !== null) throw new ChannelOptInRefusal(refusal);
  if (found === null) throw new ChannelOptInRefusal('unknown');

  const atIso = isoFromEpochMs(at);
  const live = await deps.subscriptions.findLive(found.accountId, 'telegram', start.chatId);
  let completed: CompletedTelegramLink;
  if (live !== null && live.confirmedAt !== null) {
    completed = { outcome: 'already_linked', subscriptionId: live.id };
  } else if (live !== null) {
    if (!(await deps.subscriptions.confirm(live.id, atIso))) {
      throw new ChannelOptInRefusal('revoked');
    }
    completed = { outcome: 'linked', subscriptionId: live.id };
  } else {
    const subscriptionId = deps.tokens.newId();
    await deps.subscriptions.insert({
      id: subscriptionId,
      accountId: found.accountId,
      channel: 'telegram',
      endpoint: start.chatId,
      createdAtIso: atIso,
      confirmedAtIso: atIso,
    });
    completed = { outcome: 'linked', subscriptionId };
  }

  if (!(await deps.confirmations.consume(found.id, atIso, completed.subscriptionId))) {
    throw new ChannelOptInRefusal('used');
  }
  return completed;
}

/**
 * Tells the chat how its `/start` ended. Best-effort and after the commit: a Bot API
 * outage must not undo a link the person made, and must not turn into a retry that sends
 * twice. Returns whether the acknowledgement went out. The outcome carries no reason and
 * no identifier (09 §5.3).
 */
export async function acknowledgeTelegramLink(
  bot: TelegramBotApi,
  chatId: string,
  outcome: TelegramLinkAck,
): Promise<boolean> {
  try {
    await bot.acknowledgeLink(chatId, outcome);
    return true;
  } catch {
    return false;
  }
}

// ── Unlinking ────────────────────────────────────────────────────────────────────────

/**
 * Unlinks a channel the account owns: revokes the subscription (which scrubs its endpoint
 * — 05 §5.3.3 keeps a chat id only "until the channel is unlinked") and revokes any
 * confirmation still open for it, so a mail sitting in an inbox cannot re-confirm a
 * channel its owner removed. `false` when there was nothing of the account's to unlink.
 */
export async function unlinkChannel(
  request: { readonly accountId: string; readonly subscriptionId: string },
  at: EpochMs,
  deps: Pick<ChannelOptInDeps, 'confirmations' | 'subscriptions'>,
): Promise<boolean> {
  const atIso = isoFromEpochMs(at);
  const revoked = await deps.subscriptions.revoke(request.subscriptionId, request.accountId, atIso);
  if (!revoked) return false;
  await deps.confirmations.revokeOpenForSubscription(request.subscriptionId, atIso);
  return true;
}
