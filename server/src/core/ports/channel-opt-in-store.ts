/**
 * The ports channel double opt-in needs (TASKS I3; ADR-004 D6, D8; 05 §5.5.3; migration
 * 012).
 *
 * **Tokens cross these ports only as hashes**, as for sign-in: the confirmation token is a
 * bearer secret, the database holds its SHA-256, and the one place the raw token exists is
 * between `AuthTokens.mint` and the mail or the deep link it is handed to. Minting and
 * hashing reuse the sign-in `AuthTokens` port — the same 32 random bytes, the same
 * well-formedness check.
 *
 * **Stores open no transactions.** The flows in `core/channels/channel-opt-in.ts` are plain
 * sequences; the pg adapter runs each inside one `BEGIN … COMMIT`, which is what makes
 * "count, supersede, insert, mail" and "consume, then confirm" atomic.
 *
 * Times cross as ISO-8601 strings on writes and as epoch milliseconds on reads.
 */

import type { EpochMs } from './clock.js';

/** `channel_subscriptions.channel` and `channel_confirmations.channel` (001, 012). */
export type OptInChannel = 'email' | 'telegram' | 'push';

// ── Confirmations ────────────────────────────────────────────────────────────────────

export interface NewChannelConfirmation {
  readonly id: string;
  readonly accountId: string;
  readonly channel: OptInChannel;
  /** The pending subscription confirmed; null for a Telegram link until its `/start`. */
  readonly channelSubscriptionId: string | null;
  readonly tokenHash: Uint8Array;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
}

export interface StoredChannelConfirmation {
  readonly id: string;
  readonly accountId: string;
  readonly channel: OptInChannel;
  readonly channelSubscriptionId: string | null;
  readonly issuedAt: EpochMs;
  readonly expiresAt: EpochMs;
  readonly consumedAt: EpochMs | null;
  readonly supersededAt: EpochMs | null;
  readonly revokedAt: EpochMs | null;
  /** True when the owning account is soft-deleted or erased; such a token confirms nothing. */
  readonly accountDeleted: boolean;
}

/**
 * What the re-send limit counts. Email: per address, across accounts (05 §5.5.3,
 * "≤ 3/address/day" — the limit protects the mailbox, not the account), plus every email
 * confirmation the requesting account issued in the window — unlinking scrubs the
 * endpoint, so without the account term "request, unlink, request" would reset the
 * address's count. Telegram: per account, because the chat is unknown until the `/start`.
 */
export type IssueScope =
  | { readonly channel: 'email'; readonly address: string; readonly accountId: string }
  | { readonly channel: 'telegram'; readonly accountId: string };

export interface ChannelConfirmationStore {
  /** Serializes issuance per scope for the rest of the transaction. */
  lockScope(scope: IssueScope): Promise<void>;
  /** `issued_at` of every confirmation in the scope at or after `sinceIso`. */
  issuedSince(scope: IssueScope, sinceIso: string): Promise<readonly EpochMs[]>;
  /**
   * Marks every still-open confirmation superseded: of one pending subscription, or — for
   * Telegram — every open link of the account.
   */
  supersedeOpen(
    target:
      | { readonly channelSubscriptionId: string }
      | { readonly accountId: string; readonly channel: 'telegram' },
    atIso: string,
  ): Promise<void>;
  insert(confirmation: NewChannelConfirmation): Promise<void>;
  findByTokenHash(tokenHash: Uint8Array): Promise<StoredChannelConfirmation | null>;
  /**
   * Single use, enforced by the write itself: true only if this call moved the row from
   * open to consumed. `channelSubscriptionId` is set in the same write for a Telegram link.
   */
  consume(id: string, atIso: string, channelSubscriptionId: string | null): Promise<boolean>;
  /** Revokes every still-open confirmation of the subscription (unlinking). Returns the count. */
  revokeOpenForSubscription(channelSubscriptionId: string, atIso: string): Promise<number>;
}

// ── Subscriptions ────────────────────────────────────────────────────────────────────

export interface LiveSubscription {
  readonly id: string;
  readonly confirmedAt: EpochMs | null;
}

export interface NewChannelSubscription {
  readonly id: string;
  readonly accountId: string;
  readonly channel: OptInChannel;
  /** An address, a push endpoint, or a Telegram private chat id — never a username. */
  readonly endpoint: string;
  readonly createdAtIso: string;
  /** Null for a pending subscription; the confirmation instant for a Telegram link. */
  readonly confirmedAtIso: string | null;
}

/** The writes double opt-in makes to `channel_subscriptions`. */
export interface ChannelSubscriptionWriter {
  /** The account's unrevoked subscription for this channel and endpoint, if any. */
  findLive(
    accountId: string,
    channel: OptInChannel,
    endpoint: string,
  ): Promise<LiveSubscription | null>;
  insert(subscription: NewChannelSubscription): Promise<void>;
  /**
   * Sets `confirmed_at`, conditional on the row being unconfirmed and unrevoked; true only
   * if this call confirmed it.
   */
  confirm(id: string, atIso: string): Promise<boolean>;
  /**
   * Unlinks: sets `revoked_at` and empties the endpoint (05 §5.3.3 — a chat id is retained
   * "until the channel is unlinked"). Conditional on the account owning the row and it
   * being unrevoked; true only if this call revoked it.
   */
  revoke(id: string, accountId: string, atIso: string): Promise<boolean>;
}

// ── Senders ──────────────────────────────────────────────────────────────────────────

/**
 * The verification mail. A port with **no implementation yet**: the sender, the subdomain
 * (§5.5.3: transactional mail on its own subdomain) and the landing URL's shape are
 * founder decisions, as for `AuthMailer`. Not an alert channel: a verification mail is not
 * a notification about a fire, and must not sit behind the gateway's suppression.
 *
 * The recommendation carried over from I1: the token in the URL *fragment*, and the
 * landing page POSTs it on an explicit "Confirm" click, so a mail scanner's GET cannot
 * confirm anything.
 */
export interface ChannelConfirmationMailer {
  sendConfirmation(message: {
    readonly to: string;
    readonly token: string;
    readonly expiresAtIso: string;
  }): Promise<void>;
}

/** How a `/start` ended, as the bot's reply needs to know it. No reason, no identifier. */
export type TelegramLinkAck = 'linked' | 'already_linked' | 'refused';

/**
 * The Telegram Bot API, as far as linking needs it. **No implementation yet**: the bot's
 * identity and token are founder decisions. The adapter owns the reply text (localized
 * copy lives with the catalogs), and 09 §5.3 bounds it: never the account email, a zone
 * name, an address or any identifier — the chat id is the only thing passed in.
 */
export interface TelegramBotApi {
  acknowledgeLink(chatId: string, outcome: TelegramLinkAck): Promise<void>;
}
