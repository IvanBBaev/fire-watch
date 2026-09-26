import { describe, expect, it } from 'vitest';

import type { OutboundMessage } from '../../../../core/ports/alert-channel.js';
import type { FetchLike } from '../provider-http.js';
import {
  DEFAULT_SES_QUOTA_BACKOFF_MS,
  DEFAULT_SES_THROTTLE_BACKOFF_MS,
  SES_SEND_PATH,
  createSesChannel,
  type SesSendEmailRequest,
} from './ses-channel.js';

const NOW = 1_758_200_000_000; // 2025-09-18T12:53:20Z, arbitrary
const CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const FROM = 'alerts@alerts.example.invalid';

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    outboxId: '11111111-1111-4111-8111-111111111111',
    channel: 'email',
    endpoint: 'reader@example.invalid',
    rendered: {
      title: 'Fire near Rakitovo',
      body: 'Satellite detection 3 km NE, confidence high.',
      footer: 'Fire Watch',
      url: 'https://fire-watch.example.invalid/event/1',
    },
    locale: 'bg',
    ttlSeconds: 1800,
    ...overrides,
  };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(respond: (call: Call, index: number) => Response | Error) {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: Call = { url, init: init ?? {} };
    calls.push(call);
    const reply = respond(call, calls.length - 1);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { calls, fetch };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sesError(status: number, type: string, text: string, extra: Record<string, string> = {}) {
  return json(
    status,
    { message: text },
    {
      'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.coral.service/`,
      ...extra,
    },
  );
}

function sent(call: Call): SesSendEmailRequest {
  return JSON.parse(bodyOf(call)) as SesSendEmailRequest;
}

function bodyOf(call: Call): string {
  if (typeof call.init.body !== 'string') throw new Error('expected a string body');
  return call.init.body;
}

function headerOf(call: Call, name: string): string | undefined {
  return new Headers(call.init.headers).get(name) ?? undefined;
}

function channel(fetch: FetchLike, now: () => number = () => NOW, extra = {}) {
  return createSesChannel({
    credentials: CREDENTIALS,
    region: 'eu-central-1',
    fromAddress: FROM,
    now,
    fetch,
    ...extra,
  });
}

describe('createSesChannel', () => {
  it('rejects a from address or region that cannot be right, at construction', () => {
    expect(() =>
      channel(stubFetch(() => json(200, {})).fetch, undefined, { fromAddress: 'nope' }),
    ).toThrow(RangeError);
    expect(() =>
      channel(stubFetch(() => json(200, {})).fetch, undefined, { region: 'Frankfurt' }),
    ).toThrow(RangeError);
  });

  it('rejects a message routed to another channel — a programmer error, not an outcome', async () => {
    const { calls, fetch } = stubFetch(() => json(200, { MessageId: 'x' }));
    await expect(channel(fetch).deliver(message({ channel: 'push' }))).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('posts a SigV4-signed SendEmail with subject, plain-text body and the deep link', async () => {
    const { calls, fetch } = stubFetch(() => json(200, { MessageId: '0100019...' }));
    const outcome = await channel(fetch, () => NOW, { configurationSetName: 'alerts' }).deliver(
      message(),
    );

    expect(outcome).toEqual({ kind: 'delivered', providerAckAt: NOW });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call === undefined) throw new Error('unreachable');
    expect(call.url).toBe(`https://email.eu-central-1.amazonaws.com${SES_SEND_PATH}`);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(headerOf(call, 'content-type')).toBe('application/json');
    expect(headerOf(call, 'host')).toBe('email.eu-central-1.amazonaws.com');
    expect(headerOf(call, 'x-amz-date')).toBe('20250918T125320Z');
    expect(headerOf(call, 'authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20250918\/eu-central-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(sent(call)).toEqual({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: ['reader@example.invalid'] },
      Content: {
        Simple: {
          Subject: { Data: 'Fire near Rakitovo', Charset: 'UTF-8' },
          Body: {
            Text: {
              Data: 'Satellite detection 3 km NE, confidence high.\n\nhttps://fire-watch.example.invalid/event/1\n\nFire Watch',
              Charset: 'UTF-8',
            },
          },
          Headers: [{ Name: 'Content-Language', Value: 'bg' }],
        },
      },
      ConfigurationSetName: 'alerts',
    });
  });

  it('omits the deep link and the configuration set when there are none', async () => {
    const { calls, fetch } = stubFetch(() => json(200, { MessageId: 'x' }));
    await channel(fetch).deliver(
      message({ rendered: { title: 't', body: 'b', footer: 'f', url: null } }),
    );
    const [call] = calls;
    if (call === undefined) throw new Error('unreachable');
    const request = sent(call);
    expect(request.Content.Simple.Body.Text.Data).toBe('b\n\nf');
    expect('ConfigurationSetName' in request).toBe(false);
  });

  it.each(['bg', 'en'] as const)(
    'declares the stored locale %s as Content-Language, and nothing else',
    async (locale) => {
      const { calls, fetch } = stubFetch(() => json(200, { MessageId: 'x' }));
      await channel(fetch).deliver(message({ locale }));
      const [call] = calls;
      if (call === undefined) throw new Error('unreachable');
      expect(sent(call).Content.Simple.Headers).toEqual([
        { Name: 'Content-Language', Value: locale },
      ]);
    },
  );

  it('signs each request for its own moment so a stale signature is never replayed', async () => {
    const { calls, fetch } = stubFetch(() => json(200, { MessageId: 'x' }));
    let now = NOW;
    const adapter = channel(fetch, () => now);
    await adapter.deliver(message());
    now += 61_000;
    await adapter.deliver(message());
    const [first, second] = calls;
    if (first === undefined || second === undefined) throw new Error('unreachable');
    expect(headerOf(first, 'x-amz-date')).toBe('20250918T125320Z');
    expect(headerOf(second, 'x-amz-date')).toBe('20250918T125421Z');
    expect(headerOf(first, 'authorization')).not.toBe(headerOf(second, 'authorization'));
  });

  it('pauses the whole channel on a per-second throttle for Retry-After, else the default', async () => {
    const { calls, fetch } = stubFetch((_call, index) =>
      index === 0
        ? sesError(429, 'TooManyRequestsException', 'Maximum sending rate exceeded.', {
            'retry-after': '2',
          })
        : json(200, { MessageId: 'x' }),
    );
    let now = NOW;
    const adapter = channel(fetch, () => now);

    expect(await adapter.deliver(message())).toEqual({
      kind: 'transient',
      error: 'ses throttled; backing off 2000 ms: TooManyRequests: Maximum sending rate exceeded.',
    });
    now += 1_999;
    expect(await adapter.deliver(message({ endpoint: 'other@example.invalid' }))).toEqual({
      kind: 'transient',
      error: 'ses backing off for 1 ms',
    });
    expect(calls).toHaveLength(1);
    now += 1;
    expect(await adapter.deliver(message())).toEqual({ kind: 'delivered', providerAckAt: now });
    expect(calls).toHaveLength(2);
  });

  it('falls back to the throttle default when SES sends no Retry-After', async () => {
    const { fetch } = stubFetch(() => sesError(429, 'TooManyRequestsException', 'slow down'));
    const outcome = await channel(fetch).deliver(message());
    expect(outcome).toEqual({
      kind: 'transient',
      error: `ses throttled; backing off ${String(DEFAULT_SES_THROTTLE_BACKOFF_MS)} ms: TooManyRequests: slow down`,
    });
  });

  it.each([
    ['LimitExceededException', 'Daily message quota exceeded.'],
    ['SendingPausedException', 'Sending is paused for this account.'],
    ['AccountSuspendedException', 'Account suspended.'],
  ])('pauses the channel for the quota backoff on %s', async (type, text) => {
    const { calls, fetch } = stubFetch(() => sesError(400, type, text));
    let now = NOW;
    const adapter = channel(fetch, () => now);
    const outcome = await adapter.deliver(message());
    expect(outcome).toEqual({
      kind: 'transient',
      error: `ses ${type.replace(/Exception$/, '')}; backing off ${String(DEFAULT_SES_QUOTA_BACKOFF_MS)} ms: ${type.replace(/Exception$/, '')}: ${text}`,
    });
    now += DEFAULT_SES_QUOTA_BACKOFF_MS - 1;
    expect(await adapter.deliver(message())).toEqual({
      kind: 'transient',
      error: 'ses backing off for 1 ms',
    });
    expect(calls).toHaveLength(1);
  });

  it('keeps the address when SES rejects the message itself', async () => {
    const { fetch } = stubFetch(() =>
      sesError(
        400,
        'MessageRejected',
        'Email address is not verified. The following identities failed the check in region EU-CENTRAL-1: reader@example.invalid',
      ),
    );
    const outcome = await channel(fetch).deliver(message());
    expect(outcome).toMatchObject({ kind: 'permanent', subscription: 'keep' });
    expect(outcome).toHaveProperty(
      'error',
      expect.stringContaining('ses returned 400: MessageRejected: Email address is not verified'),
    );
  });

  it.each([
    [403, 'AccessDeniedException', 'User is not authorized to perform ses:SendEmail'],
    [403, 'InvalidSignatureException', 'The request signature we calculated does not match'],
    [403, 'ExpiredTokenException', 'The security token included in the request is expired'],
    [400, 'MailFromDomainNotVerifiedException', 'The MAIL FROM domain is not verified'],
    [404, 'NotFoundException', 'Configuration set does not exist'],
  ])(
    'treats %i %s as transient — our credentials or config, never the address',
    async (status, type, text) => {
      const { fetch } = stubFetch(() => sesError(status, type, text));
      const outcome = await channel(fetch).deliver(message());
      expect(outcome).toEqual({
        kind: 'transient',
        error: `ses refused our credentials or configuration (${String(status)}): ${type.replace(/Exception$/, '')}: ${text}`,
      });
    },
  );

  it('reads the error type from the body when the header is missing', async () => {
    const { fetch } = stubFetch(() =>
      json(400, { __type: 'BadRequestException', message: 'Invalid email address' }),
    );
    const outcome = await channel(fetch).deliver(message());
    expect(outcome).toEqual({
      kind: 'permanent',
      error: 'ses returned 400: BadRequest: Invalid email address',
      subscription: 'keep',
    });
  });

  it('is transient on 5xx, on a 2xx that is not JSON we asked for, and on a network failure', async () => {
    expect(
      await channel(
        stubFetch(() => new Response('Service Unavailable', { status: 503 })).fetch,
      ).deliver(message()),
    ).toEqual({ kind: 'transient', error: 'ses returned 503: Service Unavailable' });

    const cause = new Error('getaddrinfo ENOTFOUND email.eu-central-1.amazonaws.com');
    expect(
      await channel(stubFetch(() => new TypeError('fetch failed', { cause })).fetch).deliver(
        message(),
      ),
    ).toEqual({
      kind: 'transient',
      error:
        'ses request failed: TypeError: fetch failed: getaddrinfo ENOTFOUND email.eu-central-1.amazonaws.com',
    });
  });

  it('scrubs both halves of the credential from every error', async () => {
    const leak = new TypeError('fetch failed', {
      cause: new Error(`refused ${CREDENTIALS.secretAccessKey} and ${CREDENTIALS.accessKeyId}`),
    });
    const outcome = await channel(stubFetch(() => leak).fetch).deliver(message());
    expect(outcome.kind).toBe('transient');
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(CREDENTIALS.secretAccessKey);
    expect(text).not.toContain(CREDENTIALS.accessKeyId);
    expect(text).toContain('<redacted>');

    const echo = stubFetch(() =>
      json(
        403,
        { message: `bad signature for ${CREDENTIALS.accessKeyId}/${CREDENTIALS.secretAccessKey}` },
        { 'x-amzn-errortype': 'InvalidSignatureException' },
      ),
    );
    const echoed = JSON.stringify(await channel(echo.fetch).deliver(message()));
    expect(echoed).not.toContain(CREDENTIALS.secretAccessKey);
    expect(echoed).not.toContain(CREDENTIALS.accessKeyId);
  });

  it.each([
    '',
    'reader',
    'reader@',
    '@example.invalid',
    'reader@localhost',
    'rea der@example.invalid',
    'a@b@c.d',
  ])('prunes a stored address that is not an address (%j) without a request', async (endpoint) => {
    const { calls, fetch } = stubFetch(() => json(200, { MessageId: 'x' }));
    const outcome = await channel(fetch).deliver(message({ endpoint }));
    expect(outcome).toEqual({
      kind: 'permanent',
      error: 'email address unusable: not an email address',
      subscription: 'prune',
    });
    expect(calls).toHaveLength(0);
  });
});
