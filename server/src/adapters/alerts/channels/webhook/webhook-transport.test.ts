import { randomBytes } from 'node:crypto';

import { verifyWebhookSignature } from '@fire-watch/contracts/node';
import { describe, expect, it } from 'vitest';

import type { HostResolver } from '../../../../core/ports/webhook-store.js';
import type { FetchLike } from '../provider-http.js';
import { createWebhookTransport, WEBHOOK_USER_AGENT } from './webhook-transport.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const RULES = { allowedPorts: [443], maxUrlLength: 2048 };
const URL_WITH_TOKEN = 'https://hooks.example-receiver.com/in/abc-receiver-token';

/** A placeholder generated per run; never a real credential. */
const testSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(response: Response | Error, calls: Captured[]): FetchLike {
  return (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init: init ?? {} });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
}

function resolverOf(addresses: readonly string[] | Error): HostResolver & { hosts: string[] } {
  const hosts: string[] = [];
  return {
    hosts,
    resolve(host) {
      hosts.push(host);
      return addresses instanceof Error ? Promise.reject(addresses) : Promise.resolve(addresses);
    },
  };
}

function transport(fetch: FetchLike, resolver: HostResolver) {
  return createWebhookTransport({ fetch, resolver, now: () => NOW, timeoutMs: 5000, rules: RULES });
}

describe('createWebhookTransport', () => {
  it('signs the exact body so a receiver can verify it with the published recipe', async () => {
    const calls: Captured[] = [];
    const secret = testSecret();
    const resolver = resolverOf(['93.184.216.34']);
    const body = JSON.stringify({ version: 'fire-watch.webhook.v1', type: 'ping' });
    const result = await transport(
      stubFetch(new Response(null, { status: 204 }), calls),
      resolver,
    ).send({ url: URL_WITH_TOKEN, secret, body, deliveryId: 'd-1' });

    expect(result).toEqual({ class: 'delivered', statusCode: 204, error: null, durationMs: 0 });
    expect(resolver.hosts).toEqual(['hooks.example-receiver.com']);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(URL_WITH_TOKEN);
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.body).toBe(body);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['user-agent']).toBe(WEBHOOK_USER_AGENT);
    expect(headers['x-firewatch-delivery']).toBe('d-1');
    const header = headers['x-firewatch-signature'] ?? '';
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature({ secret, header, body, nowSeconds: Math.floor(NOW / 1000) }),
    ).toEqual({ ok: true, timestampSeconds: Math.floor(NOW / 1000) });
    expect(
      verifyWebhookSignature({ secret: testSecret(), header, body, nowSeconds: NOW / 1000 }).ok,
    ).toBe(false);
  });

  it('refuses before the network when any resolved address is not public', async () => {
    for (const addresses of [['10.0.0.5'], ['93.184.216.34', '169.254.169.254'], ['::1'], []]) {
      const calls: Captured[] = [];
      const result = await transport(
        stubFetch(new Response('', { status: 200 }), calls),
        resolverOf(addresses),
      ).send({ url: URL_WITH_TOKEN, secret: testSecret(), body: '{}', deliveryId: 'd' });
      expect(result.class).toBe('refused');
      expect(result.error).toContain('non-public');
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a URL the guard rejects, without resolving it', async () => {
    const calls: Captured[] = [];
    const resolver = resolverOf(['93.184.216.34']);
    for (const url of [
      'http://hooks.example-receiver.com/in',
      'https://127.0.0.1/in',
      'https://metadata.google.internal/x',
      'https://hooks.example-receiver.com:8443/in',
    ]) {
      const result = await transport(stubFetch(new Response(''), calls), resolver).send({
        url,
        secret: testSecret(),
        body: '{}',
        deliveryId: 'd',
      });
      expect(result.class).toBe('refused');
      expect(result.error).toMatch(/^webhook url refused: /);
    }
    expect(resolver.hosts).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('checks a public IP literal without a lookup', async () => {
    const calls: Captured[] = [];
    const resolver = resolverOf(new Error('must not resolve'));
    const result = await transport(
      stubFetch(new Response('', { status: 200 }), calls),
      resolver,
    ).send({ url: 'https://93.184.216.34/in', secret: testSecret(), body: '{}', deliveryId: 'd' });
    expect(result.class).toBe('delivered');
    expect(resolver.hosts).toEqual([]);
  });

  it('retries a failed lookup and a network error, and keeps the URL and secret out of errors', async () => {
    const secret = testSecret();
    const lookup = await transport(
      stubFetch(new Response(''), []),
      resolverOf(new Error(`ENOTFOUND ${URL_WITH_TOKEN}`)),
    ).send({ url: URL_WITH_TOKEN, secret, body: '{}', deliveryId: 'd' });
    expect(lookup.class).toBe('retry');
    expect(lookup.error).not.toContain('abc-receiver-token');

    const network = await transport(
      stubFetch(new TypeError(`fetch failed for ${URL_WITH_TOKEN} with ${secret}`), []),
      resolverOf(['93.184.216.34']),
    ).send({ url: URL_WITH_TOKEN, secret, body: '{}', deliveryId: 'd' });
    expect(network).toMatchObject({ class: 'retry', statusCode: null });
    expect(network.error).not.toContain('abc-receiver-token');
    expect(network.error).not.toContain(secret);
    expect(network.error).toContain('hooks.example-receiver.com');
  });

  it('classifies the status and never quotes the receiver body', async () => {
    const cases: [number, string][] = [
      [500, 'retry'],
      [429, 'retry'],
      [408, 'retry'],
      [400, 'reject'],
      [401, 'reject'],
      [410, 'gone'],
      [200, 'delivered'],
    ];
    for (const [status, expected] of cases) {
      const result = await transport(
        stubFetch(new Response('receiver internals here', { status }), []),
        resolverOf(['93.184.216.34']),
      ).send({ url: URL_WITH_TOKEN, secret: testSecret(), body: '{}', deliveryId: 'd' });
      expect(result.class).toBe(expected);
      expect(result.statusCode).toBe(status);
      expect(result.error ?? '').not.toContain('receiver internals');
    }
  });
});
