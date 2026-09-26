import { describe, expect, it } from 'vitest';

import {
  CHAT_ID_PLACEHOLDER,
  EMAIL_PLACEHOLDER,
  isChatIdName,
  redactFreeText,
} from './free-text.js';
import { patternOnlyRedactor } from './redact.js';

/**
 * Not people. `example.com`/`example.org` are reserved for documentation (RFC 2606) and
 * `.invalid` can never resolve; the chat ids are runs of the same digit. They have the
 * *shape* of the real things because shape is all this module matches on.
 */
const ADDRESS = 'someone.fake+alerts@example.com';
const CHAT_ID = '111111111';
/** Mixed case, 35 characters after the colon: the shape of a Bot API token, and fake. */
const BOT_TOKEN = '000000000:NotARealBotToken0000000000000000000';
/** Base64url of `{"alg":"none"}` and `{"sub":"not-a-real-token"}` — a JWT-shaped string. */
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJub3QtYS1yZWFsLXRva2VuIn0.';

describe('redactFreeText — e-mail addresses', () => {
  it.each([
    [`send failed for ${ADDRESS}`, `send failed for ${EMAIL_PLACEHOLDER}`],
    // The gap this leg closes: a pg unique violation quoting the row back.
    [
      `duplicate key value violates unique constraint "accounts_email_key" DETAIL: Key (email)=(${ADDRESS}) already exists.`,
      `duplicate key value violates unique constraint "accounts_email_key" DETAIL: Key (email)=(${EMAIL_PLACEHOLDER}) already exists.`,
    ],
    ['to: <IVAN@Example.ORG>', `to: <${EMAIL_PLACEHOLDER}>`],
    ['a@b.example.co.uk,c@d.invalid', `${EMAIL_PLACEHOLDER},${EMAIL_PLACEHOLDER}`],
    ['mailto:ops@example.com', `mailto:${EMAIL_PLACEHOLDER}`],
    // Percent-encoded, as a sign-in or unsubscribe link's query carries it.
    [
      'GET https://api.invalid/v1/unsubscribe?email=someone%40example.com&x=1',
      `GET https://api.invalid/v1/unsubscribe?email=${EMAIL_PLACEHOLDER}&x=1`,
    ],
    // Trailing non-alphabetic labels are not part of the address.
    ['user@example.com.1', `${EMAIL_PLACEHOLDER}.1`],
    ['"to":"user@example.com"', `"to":"${EMAIL_PLACEHOLDER}"`],
  ])('redacts %j', (input, expected) => {
    expect(redactFreeText(input)).toBe(expected);
  });

  it.each([
    // Package versions in pnpm store paths and stack frames: the last label is numeric.
    'at Client.connect (/app/node_modules/.pnpm/pg@8.11.3/node_modules/pg/lib/client.js:12:5)',
    'node@22.1.0 @types/node@22.10.1 @fire-watch/contracts',
    // A URL authority with a role name, not a person; the URL leg owns it.
    'postgres://fire_watch@db.invalid:5432/fire_watch',
    'image@sha256:9f2c1b0a4e6d8f7a',
    'git ref HEAD@{0}',
    'user@localhost refused',
    '@ is not an address, nor is a@ or @b.com alone',
  ])('leaves %j alone', (input) => {
    expect(redactFreeText(input)).toBe(input);
  });
});

describe('redactFreeText — labelled Telegram chat ids', () => {
  it.each([
    [`chat_id: ${CHAT_ID}`, `chat_id: ${CHAT_ID_PLACEHOLDER}`],
    [`chat id -100${CHAT_ID}`, `chat id ${CHAT_ID_PLACEHOLDER}`],
    [`chatId=${CHAT_ID}`, `chatId=${CHAT_ID_PLACEHOLDER}`],
    // A Bot API body echoed inside a JSON string value: escaped quotes, placeholder bare.
    [
      `{"error":"body {\\"chat_id\\":${CHAT_ID},\\"text\\":\\"x\\"}"}`,
      `{"error":"body {\\"chat_id\\":${CHAT_ID_PLACEHOLDER},\\"text\\":\\"x\\"}"}`,
    ],
    // Raw JSON: the number becomes a *string*, so the line stays valid JSON.
    [
      `{"parameters":{"migrate_to_chat_id":-100${CHAT_ID}}}`,
      `{"parameters":{"migrate_to_chat_id":"${CHAT_ID_PLACEHOLDER}"}}`,
    ],
    [`"chat_id":"${CHAT_ID}"`, `"chat_id":"${CHAT_ID_PLACEHOLDER}"`],
  ])('redacts %j', (input, expected) => {
    const output = redactFreeText(input);
    expect(output).toBe(expected);
    expect(output).not.toContain(CHAT_ID);
  });

  it('keeps a raw JSON line parseable after redaction', () => {
    const output = redactFreeText(`{"chat_id":${CHAT_ID},"ok":false}`);

    expect(JSON.parse(output) as unknown).toStrictEqual({
      chat_id: CHAT_ID_PLACEHOLDER,
      ok: false,
    });
  });

  it.each([
    // No label, no redaction: a bare integer is a count, an epoch or a row id.
    `sent 3 alerts in 111111111 ms`,
    'telegram chat id unusable: not an integer chat id',
    'chat not found',
    'chatter_id: 12345',
  ])('leaves %j alone', (input) => {
    expect(redactFreeText(input)).toBe(input);
  });

  it('names chat-id fields for the structural leg', () => {
    expect(['chat_id', 'chatId', 'migrate_to_chat_id', 'CHAT-ID'].map(isChatIdName)).toStrictEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['chat', 'channel', 'zone_id', 'id'].map(isChatIdName)).toStrictEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('redactFreeText — stray tokens', () => {
  it('redacts a bearer or basic credential but keeps the scheme', () => {
    const bearer = 'notarealtoken0000000000';
    const basic = 'bm90OnJlYWwwMDAwMDAwMA==';

    expect(redactFreeText(`Authorization: Bearer ${bearer}`)).toBe(
      `Authorization: Bearer <${String(bearer.length)} characters>`,
    );
    expect(redactFreeText(`authorization=Basic ${basic}`)).toBe(
      `authorization=Basic <${String(basic.length)} characters>`,
    );
  });

  it('leaves prose about bearer or basic authentication alone', () => {
    const prose = 'expected Bearer authentication, got Basic credentialsmissing';

    expect(redactFreeText(prose)).toBe(prose);
  });

  it('redacts a JWT anywhere, including a VAPID authorization header', () => {
    const output = redactFreeText(`Authorization: vapid t=${JWT}, k=BPublicKey`);

    expect(output).toBe(`Authorization: vapid t=<${String(JWT.length)} characters>, k=BPublicKey`);
  });

  it('redacts a Telegram bot token, including inside a Bot API URL', () => {
    const inUrl = redactFreeText(`POST https://api.telegram.org/bot${BOT_TOKEN}/sendMessage 401`);
    const bare = redactFreeText(`token ${BOT_TOKEN} rejected`);

    expect(inUrl).toBe(
      `POST https://api.telegram.org/bot<${String(BOT_TOKEN.length)} characters>/sendMessage 401`,
    );
    expect(bare).toBe(`token <${String(BOT_TOKEN.length)} characters> rejected`);
  });

  it('leaves a lowercase digest after a counter alone', () => {
    const line = 'cycle 1234567:9f2c1b0a4e6d8f7a9f2c1b0a4e6d8f7a9f2c1b0a4e6d8f7a done';

    expect(redactFreeText(line)).toBe(line);
  });
});

describe('redactFreeText — ordinary log content survives', () => {
  it.each([
    '2026-09-26T10:15:30.123Z',
    '2026-09-26T10:15:30+03:00 cycle started',
    'request_id 3f1c2a4e-9b7d-4c1e-8f2a-0b1c2d3e4f50',
    'fire_watch_ingest_cycle_seconds_bucket{le="0.5"} 12',
    'error: 23505 unique_violation; 40P01 deadlock_detected; 57014 query_canceled',
    'at file:///app/server/dist/core/ingest/ingest-cycle.js:42:17',
    '/var/lib/fire-watch/state/backfill/2026-08.json',
    'detection 42.69770,23.32190 conf=h frp=12.5 scan=0.39',
    'bbox -10,35,45,72 at 1:2:3',
    'digest 9f2c1b0a4e6d8f7a9f2c1b0a4e6d8f7a9f2c1b0a4e6d8f7a9f2c1b0a4e6d8f7a matched',
    'firms:viirs:snpp retry 3/5 after 1500 ms',
    '<email address> <chat id> <32 characters>',
  ])('%j', (line) => {
    expect(redactFreeText(line)).toBe(line);
  });

  it('is idempotent', () => {
    const once = redactFreeText(
      `${ADDRESS} chat_id=${CHAT_ID} Bearer notarealtoken0000000000 ${JWT} ${BOT_TOKEN}`,
    );

    expect(redactFreeText(once)).toBe(once);
  });
});

describe('the free-text leg through the redactor', () => {
  it('redacts an address in an error message, its cause chain and its stack', () => {
    const error = new Error(`insert failed for ${ADDRESS}`, {
      cause: new Error('driver said', {
        cause: new Error(`Key (email)=(${ADDRESS}) already exists.`, {
          cause: { detail: `recipient ${ADDRESS}`, chat_id: Number(CHAT_ID) },
        }),
      }),
    });

    const described = patternOnlyRedactor.error(error);
    const stack = patternOnlyRedactor.stack(error) ?? '';

    expect(described).not.toContain('someone.fake');
    expect(described).not.toContain('example.com');
    expect(described).not.toContain(CHAT_ID);
    expect(described).toContain(`Key (email)=(${EMAIL_PLACEHOLDER}) already exists.`);
    expect(stack).not.toContain(ADDRESS);
    expect(stack).toContain(EMAIL_PLACEHOLDER);
  });

  it('redacts nested strings and chat-id fields structurally, keys untouched', () => {
    const output = patternOnlyRedactor.value({
      dispatch_failed: {
        channel: 'telegram',
        chat_id: Number(CHAT_ID),
        attempts: [{ to: ADDRESS, reply: { migrate_to_chat_id: `-100${CHAT_ID}` } }],
        failure: new Error(`SES rejected ${ADDRESS}`),
        count: 111111111,
        ok: false,
      },
    });

    expect(output).toStrictEqual({
      dispatch_failed: {
        channel: 'telegram',
        chat_id: CHAT_ID_PLACEHOLDER,
        attempts: [{ to: EMAIL_PLACEHOLDER, reply: { migrate_to_chat_id: CHAT_ID_PLACEHOLDER } }],
        failure: `SES rejected ${EMAIL_PLACEHOLDER}`,
        // Not a chat id by name: an ordinary number keeps its value.
        count: 111111111,
        ok: false,
      },
    });
  });

  it('leaves a null chat id, and an existing marker, as they are', () => {
    expect(patternOnlyRedactor.value({ chat_id: null, to: EMAIL_PLACEHOLDER })).toStrictEqual({
      chat_id: null,
      to: EMAIL_PLACEHOLDER,
    });
  });
});

/**
 * Bounded cost. Each input is the worst shape for one pattern — a run a naive regex would
 * rescan from every position — at 200 000 characters. A quadratic pattern takes minutes on
 * these; a linear one takes milliseconds. The bound is generous for a slow CI runner and
 * still orders of magnitude below what backtracking would cost.
 */
describe('redactFreeText — adversarial inputs', () => {
  const size = 200_000;
  const adversarial: readonly (readonly [string, string])[] = [
    ['a local-part run with no @', 'a'.repeat(size)],
    ['a local-part run ending in @ and no dot', `${'a.'.repeat(size / 2)}@${'b'.repeat(size)}`],
    ['many dotless @', 'a@'.repeat(size / 2)],
    ['a domain run with no letter TLD', `x@${'1.'.repeat(size / 2)}1`],
    ['repeated %40', '%40a'.repeat(size / 4)],
    ['repeated chat id labels', 'chat_id '.repeat(size / 8)],
    ['a chat id label before a huge number', `chat_id=${'1'.repeat(size)}`],
    ['repeated eyJ', 'eyJ'.repeat(size / 3)],
    ['a JWT header with no payload', `eyJ${'a'.repeat(size)}.`],
    ['repeated Bearer', 'Bearer '.repeat(size / 7)],
    ['a Bearer before a letters-only run', `Bearer ${'a'.repeat(size)}`],
    ['a digit run before a colon', `${'1'.repeat(size)}:${'a'.repeat(size)}`],
    ['repeated short bot-token prefixes', '1234567:'.repeat(size / 8)],
  ];

  it.each(adversarial)('%s finishes in bounded time', (_name, input) => {
    const started = performance.now();
    redactFreeText(input);
    patternOnlyRedactor.text(input);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1_000);
  });
});
