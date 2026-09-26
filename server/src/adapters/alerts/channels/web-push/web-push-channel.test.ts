import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { OutboundMessage } from '../../../../core/ports/alert-channel.js';
import { MAX_PUSH_PLAINTEXT_BYTES } from './encrypt.js';
import { createWebPushChannel } from './web-push-channel.js';

function vapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
    privateKey: jwk.d ?? '',
    subject: 'mailto:alerts@example.invalid',
  };
}

/** A browser-side subscription: a fresh P-256 pair and a 16-byte auth secret. */
function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return JSON.stringify({
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey(null, 'uncompressed').toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  });
}

function message(endpoint: string, overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    outboxId: '42',
    channel: 'push',
    endpoint,
    rendered: {
      title: 'Fire near Rakitovo',
      body: 'Satellite detections 3 km NE.',
      footer: 'Source: NASA FIRMS. Not an official warning.',
      url: 'https://fire.example.invalid/event/7',
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

const NOW = 1_758_200_000_000;

function headerOf(call: Call, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

describe('createWebPushChannel', () => {
  it('reports the push channel and the VAPID public key', () => {
    const keys = vapidKeys();
    const channel = createWebPushChannel({
      vapid: keys,
      now: () => NOW,
      fetch: stubFetch(() => new Response(null, { status: 201 })).fetch,
    });
    expect(channel.channel).toBe('push');
    expect(channel.vapidPublicKey).toBe(keys.publicKey);
  });

  it('rejects a message routed to another channel — a gateway bug, not a send failure', async () => {
    const channel = createWebPushChannel({
      vapid: vapidKeys(),
      now: () => NOW,
      fetch: stubFetch(() => new Response(null, { status: 201 })).fetch,
    });
    await expect(channel.deliver(message(subscription(), { channel: 'email' }))).rejects.toThrow(
      TypeError,
    );
  });

  it('POSTs an encrypted, VAPID-signed, TTL-bearing request and reports delivered on 201', async () => {
    const keys = vapidKeys();
    const stub = stubFetch(() => new Response(null, { status: 201 }));
    let now = NOW;
    const channel = createWebPushChannel({ vapid: keys, now: () => now, fetch: stub.fetch });
    const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk';

    const outcome = await channel.deliver(message(subscription(endpoint)));
    now += 250;

    expect(outcome).toEqual({ kind: 'delivered', providerAckAt: NOW });
    expect(stub.calls).toHaveLength(1);
    const [call] = stub.calls;
    if (call === undefined) throw new Error('unreachable');
    expect(call.url).toBe(endpoint);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(headerOf(call, 'ttl')).toBe('1800');
    expect(headerOf(call, 'urgency')).toBe('high');
    expect(headerOf(call, 'content-encoding')).toBe('aes128gcm');
    expect(headerOf(call, 'content-type')).toBe('application/octet-stream');
    expect(headerOf(call, 'authorization')).toMatch(
      new RegExp(`^vapid t=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+, k=${keys.publicKey}$`),
    );
    const body = call.init.body;
    expect(body).toBeInstanceOf(Buffer);
    if (!(body instanceof Buffer)) throw new Error('unreachable');
    expect(headerOf(call, 'content-length')).toBe(String(body.length));
    // aes128gcm header: salt(16) rs(4)=4096 idlen(1)=65, then ciphertext — no plaintext.
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body.toString('latin1')).not.toContain('Rakitovo');
    // The token's audience is the push service origin, not the full endpoint.
    const token = /t=([^,]+)/.exec(headerOf(call, 'authorization') ?? '')?.[1] ?? '';
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { aud: string };
    expect(claims.aud).toBe('https://updates.push.services.mozilla.com');
  });

  it.each([404, 410])(
    'treats %i as a dead subscription the app should re-prompt',
    async (status) => {
      const stub = stubFetch(() => new Response('gone', { status }));
      const channel = createWebPushChannel({
        vapid: vapidKeys(),
        now: () => NOW,
        fetch: stub.fetch,
      });
      await expect(channel.deliver(message(subscription()))).resolves.toEqual({
        kind: 'permanent',
        error: `push service returned ${String(status)}: gone`,
        subscription: 'reprompt',
      });
    },
  );

  it.each([401, 403])(
    'treats %i as our credential problem, never the subscription’s',
    async (status) => {
      const stub = stubFetch(() => new Response('bad jwt', { status }));
      const channel = createWebPushChannel({
        vapid: vapidKeys(),
        now: () => NOW,
        fetch: stub.fetch,
      });
      const outcome = await channel.deliver(message(subscription()));
      expect(outcome.kind).toBe('transient');
      expect(outcome).toMatchObject({ error: expect.stringContaining('VAPID') as unknown });
    },
  );

  it('treats 413 as our payload problem and keeps the subscription', async () => {
    const stub = stubFetch(() => new Response('too big', { status: 413 }));
    const channel = createWebPushChannel({ vapid: vapidKeys(), now: () => NOW, fetch: stub.fetch });
    await expect(channel.deliver(message(subscription()))).resolves.toEqual({
      kind: 'permanent',
      error: 'push service returned 413: too big',
      subscription: 'keep',
    });
  });

  it('backs off the one host that answered 429, for exactly Retry-After, and no other host', async () => {
    let status = 429;
    const stub = stubFetch(() =>
      status === 429
        ? new Response('slow down', { status, headers: { 'retry-after': '30' } })
        : new Response(null, { status: 201 }),
    );
    let now = NOW;
    const channel = createWebPushChannel({ vapid: vapidKeys(), now: () => now, fetch: stub.fetch });
    const fcm = subscription('https://fcm.googleapis.com/fcm/send/one');
    const mozilla = subscription('https://updates.push.services.mozilla.com/wpush/v2/two');

    await expect(channel.deliver(message(fcm))).resolves.toEqual({
      kind: 'transient',
      error: 'push host https://fcm.googleapis.com returned 429; backing off 30000 ms: slow down',
    });
    status = 201;
    // The next FCM row does not even reach the network while the host is paused…
    now += 29_999;
    await expect(channel.deliver(message(fcm))).resolves.toEqual({
      kind: 'transient',
      error: 'push host https://fcm.googleapis.com backing off for 1 ms',
    });
    expect(stub.calls).toHaveLength(1);
    // …but a Mozilla row goes straight through: the pause is per host, not per queue.
    await expect(channel.deliver(message(mozilla))).resolves.toMatchObject({ kind: 'delivered' });
    expect(stub.calls).toHaveLength(2);
    // And once the pause is over, FCM is retried.
    now += 1;
    await expect(channel.deliver(message(fcm))).resolves.toMatchObject({ kind: 'delivered' });
    expect(stub.calls).toHaveLength(3);
  });

  it('uses the default backoff when 429 comes without a usable Retry-After', async () => {
    const stub = stubFetch(() => new Response(null, { status: 429 }));
    const channel = createWebPushChannel({
      vapid: vapidKeys(),
      now: () => NOW,
      fetch: stub.fetch,
      defaultBackoffMs: 5_000,
    });
    await expect(channel.deliver(message(subscription()))).resolves.toEqual({
      kind: 'transient',
      error: 'push host https://fcm.googleapis.com returned 429; backing off 5000 ms',
    });
  });

  it('treats other 4xx as a rejection that keeps the subscription', async () => {
    const stub = stubFetch(() => new Response('nope', { status: 400 }));
    const channel = createWebPushChannel({ vapid: vapidKeys(), now: () => NOW, fetch: stub.fetch });
    await expect(channel.deliver(message(subscription()))).resolves.toEqual({
      kind: 'permanent',
      error: 'push service returned 400: nope',
      subscription: 'keep',
    });
  });

  it('treats 5xx and network failures as transient', async () => {
    const five = stubFetch(() => new Response('upstream', { status: 503 }));
    const channel = createWebPushChannel({ vapid: vapidKeys(), now: () => NOW, fetch: five.fetch });
    await expect(channel.deliver(message(subscription()))).resolves.toEqual({
      kind: 'transient',
      error: 'push service returned 503: upstream',
    });

    const down = stubFetch(() => new TypeError('fetch failed', { cause: new Error('ECONNRESET') }));
    const offline = createWebPushChannel({ vapid: vapidKeys(), now: () => NOW, fetch: down.fetch });
    await expect(offline.deliver(message(subscription()))).resolves.toEqual({
      kind: 'transient',
      error: 'push request failed: TypeError: fetch failed: ECONNRESET',
    });
  });

  it('scrubs the VAPID private key from anything a provider or fetch echoes back', async () => {
    const keys = vapidKeys();
    const leaky = stubFetch(
      () => new Response(`your key ${keys.privateKey} is bad`, { status: 500 }),
    );
    const channel = createWebPushChannel({ vapid: keys, now: () => NOW, fetch: leaky.fetch });
    const outcome = await channel.deliver(message(subscription()));
    expect(outcome).toEqual({
      kind: 'transient',
      error: 'push service returned 500: your key <redacted> is bad',
    });
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['missing endpoint or keys', JSON.stringify({ endpoint: 'https://x.invalid/a' })],
    [
      'endpoint is not https',
      JSON.stringify({ endpoint: 'http://x.invalid/a', keys: { p256dh: 'AA', auth: 'AA' } }),
    ],
    [
      'endpoint is not a URL',
      JSON.stringify({ endpoint: 'nope', keys: { p256dh: 'AA', auth: 'AA' } }),
    ],
    [
      'keys are not base64url',
      JSON.stringify({ endpoint: 'https://x.invalid/a', keys: { p256dh: '+/+/', auth: 'AA' } }),
    ],
    [
      'p256dh is not a P-256 point',
      JSON.stringify({ endpoint: 'https://x.invalid/a', keys: { p256dh: 'AAAA', auth: 'AA' } }),
    ],
  ])(
    'marks an unusable stored subscription (%s) permanent + reprompt without a request',
    async (why, endpoint) => {
      const stub = stubFetch(() => new Response(null, { status: 201 }));
      const channel = createWebPushChannel({
        vapid: vapidKeys(),
        now: () => NOW,
        fetch: stub.fetch,
      });
      await expect(channel.deliver(message(endpoint))).resolves.toEqual({
        kind: 'permanent',
        error: `push subscription unusable: ${why}`,
        subscription: 'reprompt',
      });
      expect(stub.calls).toHaveLength(0);
    },
  );

  it('marks a p256dh point that is not on the curve permanent + reprompt', async () => {
    const stub = stubFetch(() => new Response(null, { status: 201 }));
    const channel = createWebPushChannel({ vapid: vapidKeys(), now: () => NOW, fetch: stub.fetch });
    const bogus = JSON.stringify({
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: {
        p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x11)]).toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    });
    const outcome = await channel.deliver(message(bogus));
    expect(outcome).toMatchObject({ kind: 'permanent', subscription: 'reprompt' });
    expect(stub.calls).toHaveLength(0);
  });

  it('refuses a payload over the push cap before the request, keeping the subscription', async () => {
    const stub = stubFetch(() => new Response(null, { status: 201 }));
    const channel = createWebPushChannel({ vapid: vapidKeys(), now: () => NOW, fetch: stub.fetch });
    const huge = message(subscription(), {
      rendered: { title: 't', body: 'x'.repeat(MAX_PUSH_PLAINTEXT_BYTES), footer: 'f', url: null },
    });
    const outcome = await channel.deliver(huge);
    expect(outcome).toMatchObject({ kind: 'permanent', subscription: 'keep' });
    expect(stub.calls).toHaveLength(0);
  });
});
