import { describe, expect, it } from 'vitest';

import {
  GREECE_FEED,
  SYNTHETIC_CAP_FIRE,
  SYNTHETIC_CAP_FIRE_URL,
} from '../../core/meteoalarm/__fixtures__/meteoalarm-feeds.js';
import {
  METEOALARM_FEED_BASE_URL,
  METEOALARM_MAX_FEED_BYTES,
  createMeteoalarmHttpClient,
} from './meteoalarm-http-client.js';

function clientAnswering(respond: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createMeteoalarmHttpClient({
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url));
    },
  });
  return { client, calls };
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe('createMeteoalarmHttpClient — feeds', () => {
  it('asks for the national legacy Atom feed and hands back its validators', async () => {
    const { client, calls } = clientAnswering(
      () =>
        new Response(GREECE_FEED, {
          status: 200,
          headers: { etag: '"abc"', 'last-modified': 'Sat, 24 Oct 2026 00:05:28 GMT' },
        }),
    );
    const fetched = await client.fetchFeed('greece', null);
    expect(fetched).toEqual({
      kind: 'ok',
      body: GREECE_FEED,
      validators: { etag: '"abc"', lastModified: 'Sat, 24 Oct 2026 00:05:28 GMT' },
    });
    expect(calls[0]?.url).toBe(`${METEOALARM_FEED_BASE_URL}greece`);
    expect(calls[0]?.url).toBe('https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece');
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(header(calls[0]!.init, 'if-none-match')).toBeUndefined();
  });

  it('sends the previous validators and reads a 304 as not modified', async () => {
    const { client, calls } = clientAnswering(() => new Response(null, { status: 304 }));
    const fetched = await client.fetchFeed('bulgaria', {
      etag: '"abc"',
      lastModified: 'Sat, 24 Oct 2026 00:05:28 GMT',
    });
    expect(fetched).toEqual({ kind: 'not-modified' });
    expect(header(calls[0]!.init, 'if-none-match')).toBe('"abc"');
    expect(header(calls[0]!.init, 'if-modified-since')).toBe('Sat, 24 Oct 2026 00:05:28 GMT');
  });

  it.each([301, 404, 503])('reports HTTP %i with a short excerpt', async (code) => {
    const { client } = clientAnswering(() => new Response('x'.repeat(500), { status: code }));
    const fetched = await client.fetchFeed('turkey', null);
    expect(fetched).toMatchObject({ kind: 'failed', status: code });
    if (fetched.kind !== 'failed') return;
    expect(fetched.error.length).toBeLessThan(300);
  });

  it('turns a transport failure into status null', async () => {
    const client = createMeteoalarmHttpClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await client.fetchFeed('serbia', null)).toMatchObject({ kind: 'failed', status: null });
  });

  it('refuses an oversized body and a slug that is not one', async () => {
    const { client, calls } = clientAnswering(
      () => new Response('x'.repeat(METEOALARM_MAX_FEED_BYTES + 1), { status: 200 }),
    );
    expect(await client.fetchFeed('romania', null)).toMatchObject({ kind: 'failed' });
    expect(await client.fetchFeed('../etc', null)).toMatchObject({ kind: 'failed' });
    expect(calls).toHaveLength(1);
  });
});

describe('createMeteoalarmHttpClient — CAP alerts', () => {
  it('fetches a CAP alert on the feed host', async () => {
    const { client, calls } = clientAnswering(
      () => new Response(SYNTHETIC_CAP_FIRE, { status: 200 }),
    );
    expect(await client.fetchCap(SYNTHETIC_CAP_FIRE_URL)).toEqual({
      body: SYNTHETIC_CAP_FIRE,
      error: null,
    });
    expect(calls[0]?.init.redirect).toBe('manual');
  });

  it('never fetches a URL off MeteoAlarm', async () => {
    const { client, calls } = clientAnswering(() => new Response('', { status: 200 }));
    const fetched = await client.fetchCap('https://evil.example/cap');
    expect(fetched.body).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reports a non-200 CAP answer', async () => {
    const { client } = clientAnswering(() => new Response('gone', { status: 404 }));
    const fetched = await client.fetchCap(SYNTHETIC_CAP_FIRE_URL);
    expect(fetched.body).toBeNull();
    expect(fetched.error).toContain('404');
  });
});
