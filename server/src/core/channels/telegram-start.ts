/**
 * The Telegram deep-link `/start` payload, parsed and minimized (TASKS I3; ADR-004 D8 as
 * amended by A16; 05 §5.3.3, §5.5.3; 09 §5.3).
 *
 * Linking is user-initiated from the bot side (05 §5.5.3): the signed-in app issues a
 * confirmation token, the person opens `t.me/<bot>?start=<token>`, and Telegram delivers a
 * `/start <token>` message from that person's private chat to the bot. The token is what
 * ties the chat to the account — **the message content is trusted for nothing else**
 * (05: business logic never trusts inbound Telegram content for state changes). A text
 * that is not exactly a `/start` with a well-formed payload is not an instruction.
 *
 * **Minimization is the parser's output type.** An Update carries the sender's user id,
 * username, first and last name, language, and the chat's title and type. What leaves
 * this function is the private chat id and the token, nothing else, so no later layer can
 * store a username or a profile by accident; migration 012's CHECK refuses a non-numeric
 * Telegram endpoint as a second line.
 *
 * Refused, and why:
 *
 *   * **anything but a private chat** — a group or channel chat id addresses many people;
 *     an alert about one person's home area must not go there (09 §5.3). Group linking is
 *     a founder decision, off by default;
 *   * **a sender that is a bot** — a bot cannot be the person who opted in;
 *   * **a private chat whose id is not the sender's** — in a private chat they are equal;
 *     a mismatch is a malformed or forged update;
 *   * **an edited message** — only `message` is read; an edit cannot replay a link.
 *
 * Pure: no IO, no clock. The adapter that receives updates (webhook or polling, a founder
 * decision) hands the parsed JSON here.
 */

/**
 * Telegram's deep-link payload alphabet and length (`start` parameter: up to 64 of
 * `A-Z a-z 0-9 _ -`). The confirmation token (43 base64url characters) fits inside it;
 * whether a payload is a *well-formed token* is the token port's call, not this parser's.
 */
const START_PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `/start <payload>`, optionally addressed as `/start@BotName` (Telegram's form in chats
 * with several bots). Exactly one space and nothing after the payload.
 */
const START_COMMAND_RE = /^\/start(?:@[A-Za-z0-9_]{5,32})? (\S+)$/;

/** The largest chat id Telegram documents (at most 52 significant bits), with headroom. */
const MAX_CHAT_ID = Number.MAX_SAFE_INTEGER;

/** What a `/start` yields: the chat to send to, and the token to consume. Nothing more. */
export interface TelegramStart {
  /** The private chat id, decimal, as `channel_subscriptions.endpoint` stores it. */
  readonly chatId: string;
  readonly token: string;
}

export type TelegramStartIgnored =
  | 'not_a_message'
  | 'not_a_start_command'
  | 'not_a_private_chat'
  | 'sender_is_a_bot'
  | 'chat_is_not_the_sender'
  | 'malformed_payload';

export type TelegramStartParse =
  | { readonly kind: 'start'; readonly start: TelegramStart }
  | { readonly kind: 'ignored'; readonly reason: TelegramStartIgnored };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChatId(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_CHAT_ID
  );
}

/**
 * Parses one Telegram `Update` object. Never throws on untrusted input: anything that is
 * not a well-formed private `/start` is `ignored` with the reason, and the reason carries
 * no content from the update.
 */
export function parseTelegramStart(update: unknown): TelegramStartParse {
  const ignored = (reason: TelegramStartIgnored): TelegramStartParse => ({
    kind: 'ignored',
    reason,
  });
  if (!isRecord(update)) return ignored('not_a_message');
  const message = update['message'];
  if (!isRecord(message)) return ignored('not_a_message');

  const text = message['text'];
  if (typeof text !== 'string') return ignored('not_a_start_command');
  const command = START_COMMAND_RE.exec(text);
  if (command === null) {
    // A bare `/start` (the person typed it, or the link lost its payload) is still not a
    // link: there is no token to tie the chat to an account.
    return ignored(text.startsWith('/start') ? 'malformed_payload' : 'not_a_start_command');
  }
  const payload = command[1] ?? '';
  if (!START_PAYLOAD_RE.test(payload)) return ignored('malformed_payload');

  const chat = message['chat'];
  if (!isRecord(chat) || chat['type'] !== 'private') return ignored('not_a_private_chat');
  const chatId = chat['id'];
  if (!isChatId(chatId)) return ignored('not_a_private_chat');

  const from = message['from'];
  if (!isRecord(from)) return ignored('chat_is_not_the_sender');
  if (from['is_bot'] === true) return ignored('sender_is_a_bot');
  if (from['id'] !== chatId) return ignored('chat_is_not_the_sender');

  return { kind: 'start', start: { chatId: String(chatId), token: payload } };
}
