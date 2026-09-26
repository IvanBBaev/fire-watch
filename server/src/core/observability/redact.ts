/**
 * Log redaction (TASKS C8; A23; OPERATIONS §8.3).
 *
 * The threat this exists for is specific. The FIRMS Area API carries its credential as a
 * **URL path segment** — `…/api/area/csv/<MAP_KEY>/VIIRS_SNPP_NRT/…` — so the usual
 * defences do not apply: there is no `?key=` to strip, no header to drop, and no field
 * name to blocklist. The key travels inside ordinary strings: a `fetch` failure whose
 * message quotes the request URL, an `error.stack` from a library that formats one, a
 * `cause` chain, a config dump. Any of those reaching a log line publishes the key to
 * whoever can read logs. C8's acceptance is exactly that: grep for the key in the logs
 * and find nothing.
 *
 * **On pino.** pino is deliberately *not* a dependency, and this module needs none: it is
 * plain string work over plain values, so it runs in `core/` under the purity rules and is
 * testable without a logger at all. It is shaped so that adopting pino later is wiring,
 * not a rewrite — {@link Redactor.value} has the signature of a pino `formatters.log` hook
 * (value in, value out), and {@link Redactor.text} is what a `redact.censor` function or a
 * transport-level filter calls. Should pino arrive, it takes these two functions and the
 * call sites in `server/src/app/logging.ts` change; nothing here does.
 *
 * Three independent rules, because no one of them alone is sufficient:
 *
 *  1. **Configured secret values** — every value we hold (the FIRMS map key, the database
 *     URL, the heartbeat ping URL) is replaced wherever it occurs, in any position, in any
 *     string. Exact, no pattern guessing, no way to miss a shape.
 *  2. **Credential-shaped URL components** — inside anything that looks like a URL, a path
 *     segment or query value shaped like an API key is replaced even when we do not hold
 *     it. This is what catches a key that reached us through an upstream error, a second
 *     environment's key in a pasted URL, or a key read from somewhere config never saw.
 *
 *  3. **Free-text personal data and stray tokens** (`free-text.ts`, 2026-09-26) — e-mail
 *     addresses, labelled Telegram chat ids, auth-scheme credentials, JWTs and Telegram bot
 *     tokens, in any string. Each pattern is anchored on something ordinary log content
 *     does not contain; see that module for what was chosen, what was rejected, and why.
 *
 * Rule 2 is scoped to URL-looking substrings on purpose. Applied to free text it would
 * eat sha-256 digests, `detection_uid`s and public event ids — logs that stopped being
 * readable would be routed around within a week, and a redactor nobody routes through
 * redacts nothing.
 *
 * Redaction is always to a **length-describing placeholder** — `<32 characters>`, the
 * existing convention from `describeConfig` — never to a truncated prefix. A prefix is a
 * search space reduction handed to whoever reads the log; the length is the one property
 * that helps an operator ("the key is there, and it is 32 characters, so it is not the
 * truncated one from the env file") without helping an attacker.
 */

import { CHAT_ID_PLACEHOLDER, isChatIdName, redactFreeText } from './free-text.js';

/**
 * Below this, a "secret" is more likely to be a placeholder, a role name or a common word,
 * and replacing every occurrence of it would shred the logs it is supposed to keep
 * readable. Nothing FIRMS, Postgres or healthchecks.io issues is this short.
 */
export const MIN_REDACTABLE_SECRET_LENGTH = 8;

/** Opaque path segments at least this long, with a letter and a digit, are credentials. */
const MIN_MIXED_CREDENTIAL_LENGTH = 16;

/**
 * …and this long with letters alone, since a 24-character opaque token is not a word.
 * (A FIRMS map key is 32 alphanumerics; the two thresholds bracket it from both sides.)
 */
const MIN_OPAQUE_CREDENTIAL_LENGTH = 24;

/** Anything shorter than this is left alone even under a secret-sounding key name. */
const MIN_NAMED_VALUE_LENGTH = 8;

/** How deep an `error.cause` chain is followed before the description stops. */
const MAX_CAUSE_DEPTH = 4;

/**
 * A cycle guard for structural redaction, not a shape rule — set far above any report we
 * log, because a record deeper than the limit is replaced by a marker rather than passed
 * through: "unreadable" is a bug report, "unredacted" is an incident.
 */
const MAX_VALUE_DEPTH = 20;

/**
 * A URL inside a larger string: scheme, `://`, then everything up to whitespace or a
 * delimiter that cannot appear in a URL. Trailing punctuation may be swept in; harmless,
 * because only the components are rewritten and the remainder is put back verbatim.
 *
 * The lookbehind makes a match start only at the *beginning* of a run of scheme
 * characters, and the run may begin with digits (`401https://…`), which
 * {@link redactUrlMatch} passes through before the scheme proper. Without it the engine
 * retried the scheme from every position of a long letter run with no `://` behind it —
 * quadratic: a 200 000-letter string took about a minute (found 2026-09-26 by the
 * free-text leg's adversarial tests).
 */
const URL_LIKE = /(?<![a-zA-Z0-9+.-])[a-zA-Z0-9+.-]+:\/\/[^\s"'<>\\]+/g;
const SCHEME_START = /[a-zA-Z]/;

const OPAQUE = /^[A-Za-z0-9]+$/;
const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /[0-9]/;

/** Already-redacted markers — `<32 characters>`, `<not configured>`, `<MAP_KEY>`. */
const PLACEHOLDER = /^<[^<>]*>$/;

/**
 * Names whose *values* are secrets regardless of shape: the field-name leg, which exists
 * only as a backstop for values too short or too word-like for the pattern leg.
 */
const SECRET_NAME =
  /(?:api[_-]?key|^key$|_key$|token|secret|password|passwd|credential|signature|session|authorization|auth[_-]?header|map[_-]?key|ping[_-]?url)/i;

export interface Redactor {
  /**
   * The general entry point: a string in, the same string with every secret replaced.
   * Safe on already-serialized JSON — the placeholder contains no quote, backslash or
   * control character, so a redacted canonical-JSON line is still canonical JSON.
   */
  text(input: string): string;
  /** An error rendered for a log line: name, message and `cause` chain, redacted. */
  error(error: unknown): string;
  /** An error's stack, redacted — `null` when the value carries no stack. */
  stack(error: unknown): string | null;
  /**
   * A JSON-able value redacted structurally: strings through {@link Redactor.text}, plus
   * the field-name leg for object properties. Object keys are never rewritten — a log
   * whose *keys* shift under redaction stops being greppable.
   */
  value(input: unknown): unknown;
}

/**
 * @param secrets values known to be secret — from config, or straight from the
 * environment before config has parsed (a config *failure* is the path most likely to
 * quote the offending value back). Order does not matter; duplicates, empties and values
 * below {@link MIN_REDACTABLE_SECRET_LENGTH} are dropped.
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  // Longest first, so that a secret containing another secret — a database URL and the
  // password inside it — is replaced as the whole thing rather than left as a shell of
  // itself, and the result does not depend on the caller's ordering.
  const known = [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_REDACTABLE_SECRET_LENGTH)
    .sort((left, right) => right.length - left.length || (left < right ? -1 : 1));

  const text = (input: string): string => {
    let output = input;
    for (const secret of known) output = output.split(secret).join(placeholder(secret.length));
    return redactFreeText(output.replace(URL_LIKE, redactUrlMatch));
  };

  const redactValue = (input: unknown, depth: number): unknown => {
    if (typeof input === 'string') return text(input);
    if (depth > MAX_VALUE_DEPTH) return '<depth limit>';
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map((item) => redactValue(item, depth + 1));
    if (input instanceof Error) return describeError(input, text);

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      output[key] =
        typeof item === 'string' && isSecretByName(key, item)
          ? placeholder(item.length)
          : isChatIdName(key) && isChatIdValue(item)
            ? CHAT_ID_PLACEHOLDER
            : redactValue(item, depth + 1);
    }
    return output;
  };

  return {
    text,
    error: (error: unknown): string => describeError(error, text),
    stack: (error: unknown): string | null =>
      error instanceof Error && typeof error.stack === 'string' ? text(error.stack) : null,
    value: (input: unknown): unknown => redactValue(input, 0),
  };
}

/** A redactor that knows no secret values — still enforces the URL-shape and free-text rules. */
export const patternOnlyRedactor: Redactor = createRedactor([]);

export function placeholder(length: number): string {
  return `<${String(length)} characters>`;
}

/**
 * A scheme starts with a letter; anything before the first one (`401` in `401https://…`)
 * is not part of the URL and is kept verbatim. A run with no letter is not a URL at all.
 */
function redactUrlMatch(match: string): string {
  const start = match.search(SCHEME_START);
  if (start === -1 || start > match.indexOf('://')) return match;
  return match.slice(0, start) + redactUrlLike(match.slice(start));
}

/**
 * The rule that catches the FIRMS case. Everything structural about the URL is preserved
 * — scheme, host, the product and area segments, the ordering — because that is what
 * makes a failed request diagnosable; only the segment holding the credential is lost.
 */
function redactUrlLike(url: string): string {
  const schemeEnd = url.indexOf('://') + 3;
  const scheme = url.slice(0, schemeEnd);
  const rest = url.slice(schemeEnd);

  const queryStart = firstIndexOf(rest, ['?', '#']);
  const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const query = queryStart === -1 ? '' : rest.slice(queryStart);

  const pathStart = beforeQuery.indexOf('/');
  const authority = pathStart === -1 ? beforeQuery : beforeQuery.slice(0, pathStart);
  const path = pathStart === -1 ? '' : beforeQuery.slice(pathStart);

  return scheme + redactAuthority(authority) + redactPath(path) + redactQuery(query);
}

/** `user:password@host` — the DSN shape, and the one place a host may not be printed. */
function redactAuthority(authority: string): string {
  const at = authority.lastIndexOf('@');
  if (at === -1) return authority;
  const userinfo = authority.slice(0, at);
  const host = authority.slice(at);
  const colon = userinfo.indexOf(':');
  if (colon === -1) return authority;
  return `${userinfo.slice(0, colon)}:${placeholder(userinfo.length - colon - 1)}${host}`;
}

function redactPath(path: string): string {
  if (path === '') return '';
  return path
    .split('/')
    .map((segment) => (looksLikeCredential(segment) ? placeholder(segment.length) : segment))
    .join('/');
}

/**
 * Query values go by name *and* by shape: `?MAP_KEY=…` is caught by the name, and a
 * credential parked in an unremarkable parameter is caught by the shape.
 */
function redactQuery(query: string): string {
  if (query === '') return '';
  const prefix = query.slice(0, 1);
  return (
    prefix +
    query
      .slice(1)
      .split(/([&;#])/)
      .map((part) => {
        const equals = part.indexOf('=');
        if (equals === -1) return part;
        const name = part.slice(0, equals);
        const rawValue = part.slice(equals + 1);
        const secret =
          isSecretByName(name, rawValue) || looksLikeCredential(decodeQueryValue(rawValue));
        return secret ? `${name}=${placeholder(rawValue.length)}` : part;
      })
      .join('')
  );
}

/**
 * The shape test. Two thresholds rather than one: a 16-character mixed-case-and-digits
 * blob is a key, and so is a 24-character letters-only one, but a 16-character run of
 * letters is more likely to be `BurntAreas7Days` than a credential. Digits alone are
 * never a credential — that is a date, a step or an id.
 */
function looksLikeCredential(segment: string): boolean {
  if (!OPAQUE.test(segment) || !HAS_LETTER.test(segment)) return false;
  if (segment.length >= MIN_OPAQUE_CREDENTIAL_LENGTH) return true;
  return segment.length >= MIN_MIXED_CREDENTIAL_LENGTH && HAS_DIGIT.test(segment);
}

function isSecretByName(name: string, value: string): boolean {
  // A value that is already a marker (`<32 characters>`, `<not configured>`) is left
  // alone: re-redacting it would replace a true statement with a false one about its
  // own length.
  if (value.length < MIN_NAMED_VALUE_LENGTH || PLACEHOLDER.test(value)) return false;
  return SECRET_NAME.test(name);
}

/** A chat id as a number, a bigint or its decimal text — never `null` or a marker. */
function isChatIdValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value);
  if (typeof value === 'bigint') return true;
  return typeof value === 'string' && /^-?\d{1,20}$/.test(value.trim());
}

function decodeQueryValue(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // A malformed escape is not a reason to stop redacting the rest of the line.
    return value;
  }
}

function firstIndexOf(input: string, characters: readonly string[]): number {
  let found = -1;
  for (const character of characters) {
    const index = input.indexOf(character);
    if (index !== -1 && (found === -1 || index < found)) found = index;
  }
  return found;
}

/**
 * The message plus its `cause` chain — the chain matters because `fetch` puts the useful
 * detail (and, on some runtimes, the URL) in the cause rather than the message.
 */
function describeError(error: unknown, text: (input: string) => string): string {
  if (!(error instanceof Error)) return text(describeThrown(error));

  const parts: string[] = [error.message];
  let cause: unknown = error.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null; depth++) {
    parts.push(cause instanceof Error ? cause.message : describeThrown(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return text(parts.join(': '));
}

/**
 * A thrown value that is not an `Error` — a rejected object from a library, a string, a
 * `cause` someone attached by hand. Objects go through JSON rather than `String`, which
 * would flatten them to `[object Object]` and hide a URL sitting in a property: text this
 * function refuses to produce is text the redactor never gets to clean, and the value ends
 * up printed by some other path instead.
 */
function describeThrown(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    // Circular, or a `toJSON` that threw. Either way the log line is not the place to
    // find out; the shape of the failure is already in the enclosing message.
    return '[unserializable]';
  }
}
