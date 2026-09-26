import { describe, expect, it } from 'vitest';

import type { OutboundMessage } from '../../../../core/ports/alert-channel.js';
import { TELEGRAM_TEXT_MAX_CHARS, createTelegramChannel } from './telegram-channel.js';

const TOKEN = '123456789:AAHfiqksKZ8WmR2zSjiQ7_v4TMAKdiHm9T0';
const NOW = 1_758_200_000_000;

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    outboxId: '42',
    channel: 'telegram',
    endpoint: '987654321',
    rendered: {
      title: 'Fire near Rakitovo',
      body: 'Satellite detections 3 km NE.',
      footer: 'Source: NASA FIRMS. Not an official warning.',
      url: 'https://fire.example.invalid/event/7',
    },
    locale: 'bg',
    ttlSeconds: 21_600,
    ...overrides,
  };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(respond: (call: Call) => Response | Error) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    const outcome = respond(call);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  return { calls, fetch };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sent = () => json(200, { ok: true, result: { message_id: 1 } });

function bodyOf(call: Call): string {
  if (typeof call.init.body !== 'string') throw new Error('expected a string body');
  return call.init.body;
}

function channel(stub: ReturnType<typeof stubFetch>, now: () => number = () => NOW) {
  return createTelegramChannel({ botToken: TOKEN, now, fetch: stub.fetch });
}

describe('createTelegramChannel', () => {
  it('refuses a token that is not <bot id>:<secret>, at construction', () => {
    expect(() =>
      createTelegramChannel({
        botToken: 'not-a-token',
        now: () => NOW,
        fetch: stubFetch(sent).fetch,
      }),
    ).toThrow(RangeError);
  });

  it('rejects a message routed to another channel — a gateway bug, not a send failure', async () => {
    await expect(channel(stubFetch(sent)).deliver(message({ channel: 'push' }))).rejects.toThrow(
      TypeError,
    );
  });

  it('POSTs sendMessage as plain text with the deep link bare and reports delivered', async () => {
    const stub = stubFetch(sent);
    const outcome = await channel(stub).deliver(message());

    expect(outcome).toEqual({ kind: 'delivered', providerAckAt: NOW });
    const [call] = stub.calls;
    if (call === undefined) throw new Error('unreachable');
    expect(call.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(new Headers(call.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(bodyOf(call))).toEqual({
      chat_id: '987654321',
      text: [
        'Fire near Rakitovo',
        'Satellite detections 3 km NE.',
        'https://fire.example.invalid/event/7',
        'Source: NASA FIRMS. Not an official warning.',
      ].join('\n\n'),
    });
  });

  it('omits a missing deep link rather than sending an empty paragraph', async () => {
    const stub = stubFetch(sent);
    await channel(stub).deliver(
      message({ rendered: { title: 't', body: 'b', footer: 'f', url: null } }),
    );
    const [call] = stub.calls;
    if (call === undefined) throw new Error('unreachable');
    const body = JSON.parse(bodyOf(call)) as { text: string };
    expect(body.text).toBe('t\n\nb\n\nf');
  });

  it('honours retry_after exactly: pauses the whole channel and resumes on the tick', async () => {
    let flood = true;
    const stub = stubFetch(() =>
      flood
        ? json(429, {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 3',
            parameters: { retry_after: 3 },
          })
        : sent(),
    );
    let now = NOW;
    const adapter = channel(stub, () => now);

    await expect(adapter.deliver(message())).resolves.toEqual({
      kind: 'transient',
      error: 'telegram flood control: 429, backing off 3000 ms: Too Many Requests: retry after 3',
    });
    flood = false;
    now += 2_999;
    // Another chat, same bot: the flood budget is the bot's, so no request is made.
    await expect(adapter.deliver(message({ endpoint: '111' }))).resolves.toEqual({
      kind: 'transient',
      error: 'telegram flood control: backing off for 1 ms',
    });
    expect(stub.calls).toHaveLength(1);
    now += 1;
    await expect(adapter.deliver(message())).resolves.toMatchObject({ kind: 'delivered' });
    expect(stub.calls).toHaveLength(2);
  });

  it('falls back to Retry-After, then to the default, when retry_after is missing', async () => {
    const header = stubFetch(
      () =>
        new Response('{"ok":false,"error_code":429}', {
          status: 429,
          headers: { 'retry-after': '7' },
        }),
    );
    await expect(channel(header).deliver(message())).resolves.toEqual({
      kind: 'transient',
      error: 'telegram flood control: 429, backing off 7000 ms: {"ok":false,"error_code":429}',
    });

    const bare = stubFetch(() => new Response(null, { status: 429 }));
    const adapter = createTelegramChannel({
      botToken: TOKEN,
      now: () => NOW,
      fetch: bare.fetch,
      defaultBackoffMs: 1_500,
    });
    await expect(adapter.deliver(message())).resolves.toEqual({
      kind: 'transient',
      error: 'telegram flood control: 429, backing off 1500 ms',
    });
  });

  it.each([
    'Forbidden: bot was blocked by the user',
    'Forbidden: user is deactivated',
    'Forbidden: bot was kicked from the group chat',
  ])('prunes the chat on 403 (%s)', async (description) => {
    const stub = stubFetch(() => json(403, { ok: false, error_code: 403, description }));
    await expect(channel(stub).deliver(message())).resolves.toEqual({
      kind: 'permanent',
      error: `telegram 403: ${description}`,
      subscription: 'prune',
    });
  });

  it('prunes a chat Telegram cannot find, or that migrated away from the stored id', async () => {
    const gone = stubFetch(() =>
      json(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
    );
    await expect(channel(gone).deliver(message())).resolves.toEqual({
      kind: 'permanent',
      error: 'telegram 400: Bad Request: chat not found',
      subscription: 'prune',
    });

    const migrated = stubFetch(() =>
      json(400, {
        ok: false,
        error_code: 400,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: -1001234567890 },
      }),
    );
    await expect(channel(migrated).deliver(message({ endpoint: '-123' }))).resolves.toEqual({
      kind: 'permanent',
      error:
        'telegram chat migrated to a supergroup: Bad Request: group chat was upgraded to a supergroup chat',
      subscription: 'prune',
    });
  });

  it('keeps the chat on a 400 that is about our request', async () => {
    const stub = stubFetch(() =>
      json(400, { ok: false, error_code: 400, description: 'Bad Request: message is too long' }),
    );
    await expect(channel(stub).deliver(message())).resolves.toEqual({
      kind: 'permanent',
      error: 'telegram 400: Bad Request: message is too long',
      subscription: 'keep',
    });
  });

  it.each([401, 404])('treats %i as our token problem, never the chat’s', async (status) => {
    const stub = stubFetch(() =>
      json(status, { ok: false, error_code: status, description: 'Unauthorized' }),
    );
    await expect(channel(stub).deliver(message())).resolves.toEqual({
      kind: 'transient',
      error: `telegram rejected our bot token (${String(status)}): Unauthorized`,
    });
  });

  it('treats 5xx, a 200 without ok:true, and network failures as transient', async () => {
    const five = stubFetch(() => new Response('Bad Gateway', { status: 502 }));
    await expect(channel(five).deliver(message())).resolves.toEqual({
      kind: 'transient',
      error: 'telegram returned 502: Bad Gateway',
    });

    const odd = stubFetch(() => new Response('<html>', { status: 200 }));
    await expect(channel(odd).deliver(message())).resolves.toEqual({
      kind: 'transient',
      error: 'telegram returned 200: <html>',
    });

    const down = stubFetch(() => new TypeError('fetch failed', { cause: new Error('ENOTFOUND') }));
    await expect(channel(down).deliver(message())).resolves.toEqual({
      kind: 'transient',
      error: 'telegram request failed: TypeError: fetch failed: ENOTFOUND',
    });
  });

  it('scrubs the bot token from anything fetch or Telegram echoes back', async () => {
    const leakyFetch = stubFetch(
      (call) => new TypeError(`fetch failed`, { cause: new Error(`connect ${call.url}`) }),
    );
    const viaFetch = await channel(leakyFetch).deliver(message());
    expect(viaFetch).toEqual({
      kind: 'transient',
      error:
        'telegram request failed: TypeError: fetch failed: connect https://api.telegram.org/bot<redacted>/sendMessage',
    });

    const leakyBody = stubFetch(() =>
      json(500, { ok: false, error_code: 500, description: `token ${TOKEN} broke` }),
    );
    const viaBody = await channel(leakyBody).deliver(message());
    expect(viaBody).toEqual({
      kind: 'transient',
      error: 'telegram returned 500: token <redacted> broke',
    });
  });

  it('prunes a stored endpoint that is not a chat id, without a request', async () => {
    const stub = stubFetch(sent);
    for (const endpoint of ['', 'abc', '12.5', '0123', '{"endpoint":"x"}']) {
      await expect(channel(stub).deliver(message({ endpoint }))).resolves.toEqual({
        kind: 'permanent',
        error: 'telegram chat id unusable: not an integer chat id',
        subscription: 'prune',
      });
    }
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses text over the Bot API cap before the request, keeping the chat', async () => {
    const stub = stubFetch(sent);
    const outcome = await channel(stub).deliver(
      message({
        rendered: { title: 't', body: 'x'.repeat(TELEGRAM_TEXT_MAX_CHARS), footer: 'f', url: null },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'permanent', subscription: 'keep' });
    expect(stub.calls).toHaveLength(0);
  });
});
