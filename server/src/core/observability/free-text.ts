/**
 * The free-text leg of log redaction (TASKS C8 redaction leg, extended 2026-09-26 for the
 * personal-data half of 05 §5.3.2 and RoPA §7).
 *
 * The two legs in `redact.ts` know *secrets*: values we hold, and credential-shaped URL
 * components. Neither knows personal data. An e-mail address has no secret to match and no
 * URL to live in, and it reaches a log line the same way the FIRMS key would — inside a
 * string nobody decided to log: a pg error echoing a row (`Key (email)=(…) already
 * exists.`), a provider reply quoting the recipient, a `cause` chain, a stack. This module
 * is the pass that runs over every string the redactor sees, after the other two legs.
 *
 * **What is matched, and why each pattern is shaped the way it is.** Every pattern here is
 * anchored on something a normal log line does not contain — an `@`, a literal scheme word,
 * a `chat_id` label, the `eyJ` that base64 of `{"` always starts with — so that the common
 * case (an ISO timestamp, a UUID request id, a metric name, a SQL state, a file path, a
 * sha-256 digest, a coordinate from a public detection) never matches at all. A redactor
 * that shreds ordinary lines gets routed around, and one nobody routes through redacts
 * nothing; so a pattern that could not be made precise was left out rather than loosened
 * (see the rejected list at the bottom of this comment).
 *
 *  1. **E-mail addresses** (personal: RoPA `accounts.email`, `channel_subscriptions.endpoint`;
 *     05 §5.3.2). `local@domain.tld`, and the percent-encoded `local%40domain.tld` a URL query
 *     carries. The last domain label must be 2–63 letters, which is what keeps `pg@8.11.3`
 *     in a pnpm stack path and `node@22.1.0` intact. An address directly after `//` is a URL
 *     authority (`postgres://fire_watch@db.invalid`) — a role name, not a person — and is
 *     left to the URL leg. Replaced by `<email address>`, not by its length: the length of
 *     an address says nothing useful to an operator and narrows it for anyone else, and the
 *     domain is dropped too, since a personal domain is the person.
 *  2. **Telegram chat ids behind a `chat_id` label** (personal: RoPA "online identifier",
 *     DPIA R4). A chat id is a bare integer, indistinguishable from a count, an epoch or a
 *     row id, so there is *no* free-text pattern for one on its own — only the labelled form
 *     (`chat_id: 123`, `"chat_id":123`, `chat id 123`, a Bot API `migrate_to_chat_id`)
 *     where the label makes the number unambiguous. {@link isChatIdName} is the structural
 *     twin, for a field of that name. Replaced by `<chat id>`.
 *  3. **Credentials after an HTTP auth scheme** — `Bearer <token>` / `Basic <token>`, as an
 *     echoed request header or a library's debug string carries them. Secrets, not personal
 *     data, but a header echo is exactly the arbitrary string the other legs cannot see
 *     unless the token is one we hold. The token must be ≥ 16 characters with a letter and
 *     a digit, so the prose "bearer authentication" is left alone.
 *  4. **JWTs** — `eyJ….eyJ….sig`: the VAPID `Authorization: vapid t=<jwt>` header is one.
 *     Both leading segments must start `eyJ` (base64url of `{"`), so no ordinary token of
 *     text looks like one.
 *  5. **Telegram bot tokens** — `<bot id>:<secret>`, including inside a Bot API URL
 *     (`/bot<id>:<secret>/sendMessage`), whose `:` keeps the URL leg's opaque-segment rule
 *     from firing. The secret half must be ≥ 30 characters and mixed-case, which excludes a
 *     lowercase hex digest after a `1234567:` counter.
 *
 * Secrets in 3–5 become the usual `<N characters>`; they are backstops for tokens this
 * process was not given, since held ones are already replaced exactly by value.
 *
 * **Rejected**, each for a named reason:
 *  - *Bare chat ids / any long integer* — indistinguishable from counts, epoch millis, row
 *    ids and FIRMS scan numbers; would make every numeric log unreadable.
 *  - *Latitude/longitude pairs* — 05 §5.3.2 says "no coordinates in application logs", but
 *    the coordinates this system logs are overwhelmingly *public* detections and bboxes
 *    (the FIRMS area segment `-10,35,45,72`, replay reports, cycle reports), and a zone
 *    centre has exactly the same shape. The rule is enforced at source (zones are logged
 *    by id); a pattern here would censor the product's own public data and break the
 *    replay report's diagnostic value without a precision gain.
 *  - *IP addresses* — access logs hold them by design for ≤ 30 days (LIA-1); in application
 *    logs they are the database host and the upstream peer in connection errors, which
 *    operators need.
 *  - *Phone numbers, names, street addresses* — the product collects none (RoPA), and no
 *    pattern for them is precise.
 *
 * **Cost is bounded.** Each pattern starts only where its anchor is (a lookbehind forbids
 * starting in the middle of a run, so a 100 000-character run is scanned once, not 100 000
 * times), quantified runs are separated by delimiters the runs cannot contain, and a string
 * without the anchor character skips the pattern entirely. The adversarial-input tests pin
 * this with a time bound.
 */

/** What an e-mail address becomes. No quote, backslash or control character: JSON-safe. */
export const EMAIL_PLACEHOLDER = '<email address>';

/** What a labelled Telegram chat id becomes. */
export const CHAT_ID_PLACEHOLDER = '<chat id>';

/**
 * `local@domain.label…` or `local%40domain.label…`. The lookbehind makes the start the
 * beginning of the local-part run (linear cost) and not the host after a `//` (a URL
 * authority, which the URL leg owns). The domain is checked label by label in
 * {@link redactEmail}, rather than by a trailing `\.[A-Za-z]{2,}` here, so the regex has
 * one greedy way to match and nothing to backtrack into.
 */
const EMAIL =
  /(?<![A-Za-z0-9._%+-]|\/\/)[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TOP_LEVEL_LABEL = /^[A-Za-z]{2,63}$/;

/**
 * A `chat_id` / `chatId` / `chat id` label, an optional (possibly escaped) closing quote, a
 * `:` / `=` / whitespace separator, an optional opening quote, and the integer. The
 * lookbehind allows a `_` before `chat`, so the Bot API's `migrate_to_chat_id` matches.
 */
const CHAT_ID =
  /(?<![A-Za-z0-9])(chat[ _-]?id)(\\?["']?)([ \t]*[:=][ \t]*|[ \t]+)(\\?["']?)(-?\d{1,20})(?!\d)/gi;

/** A field whose value is a Telegram chat id, whatever its type. */
const CHAT_ID_NAME = /chat[_-]?id$/i;

const AUTH_SCHEME =
  /(?<![A-Za-z0-9_-])(Bearer|bearer|BEARER|Basic|basic|BASIC)([ \t]+)([A-Za-z0-9._~+/=-]{16,})/g;

const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** The start may follow a non-token character, the start of input, or `/bot` in a URL. */
const TELEGRAM_BOT_TOKEN = /(?<=^|[^A-Za-z0-9_:-]|\/bot)\d{6,12}:[A-Za-z0-9_-]{30,}/g;

const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /[0-9]/;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;

/** Runs every free-text pattern over one string. Idempotent: no placeholder re-matches. */
export function redactFreeText(input: string): string {
  let output = input;
  if (output.includes('@') || output.includes('%40')) output = output.replace(EMAIL, redactEmail);
  if (/chat/i.test(output)) output = output.replace(CHAT_ID, redactChatId);
  if (output.includes('eyJ')) output = output.replace(JWT, (token) => lengthOf(token));
  if (/bearer|basic/i.test(output)) output = output.replace(AUTH_SCHEME, redactAuthScheme);
  if (output.includes(':')) output = output.replace(TELEGRAM_BOT_TOKEN, redactBotToken);
  return output;
}

/** True when a structured field of this name holds a Telegram chat id. */
export function isChatIdName(name: string): boolean {
  return CHAT_ID_NAME.test(name);
}

/**
 * Accepts the match only when its last domain label is alphabetic, trimming trailing
 * labels that are not (`a@example.com.1` → `<email address>.1`); a match with no such
 * label (`pg@8.11.3`) is a package version, not an address, and is returned intact.
 */
function redactEmail(match: string): string {
  const at = match.indexOf('@');
  const separator = at === -1 ? match.lastIndexOf('%40') : at;
  const domainStart = separator + (at === -1 ? 3 : 1);
  const labels = match.slice(domainStart).split('.');
  while (labels.length >= 2 && !TOP_LEVEL_LABEL.test(labels[labels.length - 1] ?? '')) {
    labels.pop();
  }
  if (labels.length < 2) return match;
  const matchedLength = domainStart + labels.join('.').length;
  return EMAIL_PLACEHOLDER + match.slice(matchedLength);
}

/**
 * Keeps the label and the separator (so the line still says a chat id was there) and
 * replaces the number. A bare number after a *raw* JSON key quote becomes a quoted string,
 * so a serialized line stays valid JSON; after an escaped quote (`\"chat_id\":123`) the
 * text is inside a JSON string already and takes the placeholder as is.
 */
function redactChatId(
  _match: string,
  label: string,
  closingQuote: string,
  separator: string,
  openingQuote: string,
): string {
  const replacement =
    closingQuote === '"' && openingQuote === '' ? `"${CHAT_ID_PLACEHOLDER}"` : CHAT_ID_PLACEHOLDER;
  return `${label}${closingQuote}${separator}${openingQuote}${replacement}`;
}

function redactAuthScheme(match: string, scheme: string, space: string, token: string): string {
  if (!HAS_LETTER.test(token) || !HAS_DIGIT.test(token)) return match;
  return `${scheme}${space}${lengthOf(token)}`;
}

function redactBotToken(match: string): string {
  const secret = match.slice(match.indexOf(':') + 1);
  return HAS_UPPER.test(secret) && HAS_LOWER.test(secret) ? lengthOf(match) : match;
}

function lengthOf(value: string): string {
  return `<${String(value.length)} characters>`;
}
