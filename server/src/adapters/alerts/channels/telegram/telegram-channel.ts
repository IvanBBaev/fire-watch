/**
 * The `telegram` channel — Bot API `sendMessage` to a chat the user linked to the bot.
 *
 * Telegram is the co-equal channel of 08 §5.4.3 and F-2: the one that reaches an iPhone
 * whose owner never installed the app. What 04-sre §5 says about it — "~30 msg/s
 * overall; 1 msg/s per chat; `429` returns `retry_after` — honor it exactly" — is the
 * whole design here. The token bucket in front of this adapter keeps us at 25/s so the
 * interactive bot has headroom; the `retry_after` handling below is the second line,
 * for the moments Telegram disagrees with our arithmetic. The per-chat 1/s rule is not
 * enforced separately: one chat gets one alert per (zone, event) decision, and a user
 * whose several zones fire in one second is answered by Telegram with a `retry_after`
 * that pauses the channel for the second it asks for.
 *
 * The table, from the Bot API's documented error strings:
 *
 *   | reply                                   | outcome              | why                                        |
 *   |-----------------------------------------|----------------------|--------------------------------------------|
 *   | `ok: true`                              | delivered            | Telegram holds it until the client appears |
 *   | 429 `parameters.retry_after`            | transient, channel   | flood control; every chat shares the bot's |
 *   |                                         | paused for exactly   | budget, so pausing one row would just move |
 *   |                                         | that long            | the 429 to the next                        |
 *   | 403 (blocked, deactivated, kicked)      | permanent · `prune`  | the user ended the relationship            |
 *   | 400 "chat not found" / migrated chat id | permanent · `prune`  | the stored handle addresses nothing        |
 *   | 400 other                               | permanent · `keep`   | our request; the chat is fine              |
 *   | 401, 404                                | transient            | *our* token — never prune anyone for it    |
 *   | 5xx, network                            | transient            | retried until D6's 6 h expiry              |
 *
 * `prune` rather than `reprompt` for a dead chat: a blocked bot is the user saying no,
 * and "chat not found" means the id never was or is no longer theirs. Re-linking is a
 * `/start` in Telegram, which the app cannot prompt for the way it can for push.
 *
 * The bot token is a secret that can *send* (04-sre §7) and it sits in the request URL,
 * so it is scrubbed from every error this adapter returns and the request never follows
 * a redirect that could carry it elsewhere.
 */

import type {
  AlertChannelAdapter,
  DeliveryOutcome,
  OutboundMessage,
} from '../../../../core/ports/alert-channel.js';
import { excerpt, providerRequest, retryAfterMs, type FetchLike } from '../provider-http.js';

export interface TelegramChannelOptions {
  /** BotFather's `<bot id>:<secret>`. Never logged; scrubbed from provider errors. */
  readonly botToken: string;
  readonly now: () => number;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Override for tests; production talks to `https://api.telegram.org`. */
  readonly apiBaseUrl?: string;
  /** Pause applied on a 429 that carries no usable `retry_after`. */
  readonly defaultBackoffMs?: number;
}

export const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000;
export const DEFAULT_TELEGRAM_BACKOFF_MS = 5_000;
export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
/** Bot API `sendMessage` `text` limit, in UTF-16 code units — what Telegram counts. */
export const TELEGRAM_TEXT_MAX_CHARS = 4096;

/** The Bot API's reply envelope, the parts this adapter reads. */
interface BotApiReply {
  readonly ok?: unknown;
  readonly error_code?: unknown;
  readonly description?: unknown;
  readonly parameters?: { readonly retry_after?: unknown; readonly migrate_to_chat_id?: unknown };
}

export function createTelegramChannel(options: TelegramChannelOptions): AlertChannelAdapter {
  assertBotToken(options.botToken);
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS;
  const defaultBackoffMs = options.defaultBackoffMs ?? DEFAULT_TELEGRAM_BACKOFF_MS;
  const url = `${options.apiBaseUrl ?? TELEGRAM_API_BASE_URL}/bot${options.botToken}/sendMessage`;
  const redact = [options.botToken];

  let pausedUntil: number | null = null;

  return {
    channel: 'telegram',
    async deliver(message: OutboundMessage): Promise<DeliveryOutcome> {
      if (message.channel !== 'telegram') {
        // Inside an `async` function this is a rejection, not a synchronous throw.
        throw new TypeError(`telegram channel received a message routed to ${message.channel}`);
      }

      if (!isChatId(message.endpoint)) {
        return {
          kind: 'permanent',
          error: 'telegram chat id unusable: not an integer chat id',
          subscription: 'prune',
        };
      }

      const now = options.now();
      if (pausedUntil !== null) {
        if (now < pausedUntil) {
          return {
            kind: 'transient',
            error: `telegram flood control: backing off for ${String(pausedUntil - now)} ms`,
          };
        }
        pausedUntil = null;
      }

      const text = renderText(message);
      if (text.length > TELEGRAM_TEXT_MAX_CHARS) {
        return {
          kind: 'permanent',
          error: `telegram text is ${String(text.length)} chars; the cap is ${String(TELEGRAM_TEXT_MAX_CHARS)}`,
          subscription: 'keep',
        };
      }

      const result = await providerRequest({
        fetch: doFetch,
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Plain text, no `parse_mode`: the copy is prose the D7 lint cleared, and a
        // Markdown parser would turn an underscore in a place name into a 400.
        body: JSON.stringify({ chat_id: message.endpoint, text }),
        timeoutMs,
        redact,
      });

      if (result.status === null) {
        return { kind: 'transient', error: `telegram request failed: ${result.error}` };
      }
      const { status } = result;
      // `rawBody` is already redacted; the excerpt keeps a verbose reply off the log line.
      const reply = parseReply(result.rawBody);
      const description =
        typeof reply.description === 'string' && reply.description.length > 0
          ? excerpt(reply.description)
          : result.body;
      const detail = description.length > 0 ? `: ${description}` : '';

      if (status >= 200 && status < 300 && reply.ok === true) {
        return { kind: 'delivered', providerAckAt: options.now() };
      }
      if (status === 429) {
        const retryAfter = reply.parameters?.retry_after;
        const backoff =
          typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
            ? Math.round(retryAfter * 1000)
            : (retryAfterMs(result.headers, now) ?? defaultBackoffMs);
        pausedUntil = now + backoff;
        return {
          kind: 'transient',
          error: `telegram flood control: 429, backing off ${String(backoff)} ms${detail}`,
        };
      }
      if (status === 403) {
        return { kind: 'permanent', error: `telegram 403${detail}`, subscription: 'prune' };
      }
      if (status === 400) {
        const migrated = reply.parameters?.migrate_to_chat_id;
        if (typeof migrated === 'number' || typeof migrated === 'string') {
          return {
            kind: 'permanent',
            error: `telegram chat migrated to a supergroup${detail}`,
            subscription: 'prune',
          };
        }
        if (/chat not found|user not found|peer_id_invalid|chat_id is empty/i.test(description)) {
          return { kind: 'permanent', error: `telegram 400${detail}`, subscription: 'prune' };
        }
        return { kind: 'permanent', error: `telegram 400${detail}`, subscription: 'keep' };
      }
      if (status === 401 || status === 404) {
        return {
          kind: 'transient',
          error: `telegram rejected our bot token (${String(status)})${detail}`,
        };
      }
      if (status >= 400 && status < 500) {
        return {
          kind: 'permanent',
          error: `telegram returned ${String(status)}${detail}`,
          subscription: 'keep',
        };
      }
      return { kind: 'transient', error: `telegram returned ${String(status)}${detail}` };
    },
  };
}

/**
 * Title, body, deep link, footer — blank-line separated, as a Telegram client renders
 * plain text. The link is left bare so Telegram's own preview (which 08 §7 gives OG tags
 * at the edge for) can show the event card.
 */
function renderText(message: OutboundMessage): string {
  const { title, body, footer, url } = message.rendered;
  return [title, body, url, footer].filter((part) => part !== null && part.length > 0).join('\n\n');
}

/** Bot API chat ids are 64-bit integers; groups are negative. Stored as decimal text. */
function isChatId(endpoint: string): boolean {
  return /^-?[1-9]\d{0,19}$/.test(endpoint);
}

function assertBotToken(token: string): void {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new RangeError('Telegram bot token must look like <bot id>:<secret>');
  }
}

function parseReply(rawBody: string): BotApiReply {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
