import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../config.js';
import { applyClientConfig, fetchClientConfig, parseClientConfig } from './client-config.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseClientConfig', () => {
  it('reads the three transport fields', () => {
    expect(
      parseClientConfig({
        transport: 'sse',
        poll_interval_ms: 60_000,
        static_snapshot_url: 'https://static.example/snapshot.json',
      }),
    ).toEqual({
      transport: 'sse',
      pollIntervalMs: 60_000,
      staticSnapshotUrl: 'https://static.example/snapshot.json',
    });
  });

  it('returns no overrides for a non-object', () => {
    for (const value of [null, undefined, 'poll', 42, [], true]) {
      expect(parseClientConfig(value)).toEqual({});
    }
  });

  it('drops each malformed field on its own and keeps the rest', () => {
    expect(
      parseClientConfig({
        transport: 'websocket',
        poll_interval_ms: 45_000,
        static_snapshot_url: 7,
      }),
    ).toEqual({ pollIntervalMs: 45_000 });
  });

  it('rejects poll intervals outside the sane range', () => {
    for (const bad of [0, -1, 4_999, 31 * 60_000, Number.NaN, Number.POSITIVE_INFINITY, '45000']) {
      expect(parseClientConfig({ poll_interval_ms: bad })).toEqual({});
    }
    expect(parseClientConfig({ poll_interval_ms: 5_000 })).toEqual({ pollIntervalMs: 5_000 });
    expect(parseClientConfig({ poll_interval_ms: 30 * 60_000 })).toEqual({
      pollIntervalMs: 30 * 60_000,
    });
    expect(parseClientConfig({ poll_interval_ms: 45_000.4 })).toEqual({ pollIntervalMs: 45_000 });
  });

  it('accepts an explicit null static url (no T2 copy) and ignores an empty string', () => {
    expect(parseClientConfig({ static_snapshot_url: null })).toEqual({ staticSnapshotUrl: null });
    expect(parseClientConfig({ static_snapshot_url: '' })).toEqual({});
  });
});

describe('applyClientConfig', () => {
  it('maps transport onto sseEnabled and leaves untouched fields alone', () => {
    const on = applyClientConfig(DEFAULT_CONFIG, { transport: 'sse' });
    expect(on.sseEnabled).toBe(true);
    expect(on.pollIntervalMs).toBe(DEFAULT_CONFIG.pollIntervalMs);
    const off = applyClientConfig({ ...DEFAULT_CONFIG, sseEnabled: true }, { transport: 'poll' });
    expect(off.sseEnabled).toBe(false);
  });

  it('with no overrides returns an equal config', () => {
    expect(applyClientConfig(DEFAULT_CONFIG, {})).toEqual(DEFAULT_CONFIG);
  });

  it('can clear the static url', () => {
    const withStatic = { ...DEFAULT_CONFIG, staticSnapshotUrl: 'https://s/x.json' };
    expect(applyClientConfig(withStatic, { staticSnapshotUrl: null }).staticSnapshotUrl).toBeNull();
    expect(applyClientConfig(withStatic, {}).staticSnapshotUrl).toBe('https://s/x.json');
  });
});

describe('fetchClientConfig', () => {
  it('fetches the configured url with a JSON accept header and merges the answer', async () => {
    const calls: Array<[unknown, RequestInit | undefined]> = [];
    const fetchFn: typeof fetch = (input, init) => {
      calls.push([input, init]);
      return Promise.resolve(jsonResponse({ transport: 'sse', poll_interval_ms: 90_000 }));
    };
    const config = await fetchClientConfig(fetchFn, DEFAULT_CONFIG);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(DEFAULT_CONFIG.clientConfigUrl);
    expect(calls[0]?.[1]).toEqual({ headers: { accept: 'application/json' } });
    expect(config.sseEnabled).toBe(true);
    expect(config.pollIntervalMs).toBe(90_000);
  });

  it('returns the defaults untouched on a network failure', async () => {
    const fetchFn: typeof fetch = () => Promise.reject(new TypeError('failed to fetch'));
    expect(await fetchClientConfig(fetchFn, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG);
  });

  it('returns the defaults on a non-2xx status without reading the body', async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(jsonResponse({ transport: 'sse' }, 503));
    expect(await fetchClientConfig(fetchFn, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG);
  });

  it('returns the defaults when the body is not JSON', async () => {
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      );
    expect(await fetchClientConfig(fetchFn, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG);
  });

  it('a synchronous throw from the fetch function is also a failure, not a crash', async () => {
    const fetchFn = (() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    expect(await fetchClientConfig(fetchFn, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG);
  });
});
