import { describe, expect, it } from 'vitest';

import { createPublicObjectProbe } from './public-object-probe.js';

const URL_ = 'https://t2.fire-watch.example/snapshot.json';

function respond(response: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }) as typeof fetch;
  return { calls, probe: createPublicObjectProbe({ url: URL_, fetch: fetchFn }) };
}

describe('createPublicObjectProbe', () => {
  it('sends one unauthenticated HEAD, with no cache-busting, redirects refused', async () => {
    const { calls, probe } = respond(new Response(null, { status: 200 }));
    await probe.head();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_);
    expect(calls[0]?.init.method).toBe('HEAD');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.headers).toBeUndefined();
  });

  it('reads the job-written stamp and Last-Modified, ignoring Date and Age', async () => {
    const { probe } = respond(
      new Response(null, {
        status: 200,
        headers: {
          'x-amz-meta-generated-at': '2026-07-14T10:15:00Z',
          'last-modified': 'Tue, 14 Jul 2026 10:15:02 GMT',
          date: 'Tue, 14 Jul 2026 10:20:00 GMT',
          age: '0',
          etag: '"e1"',
          'cache-control': 'public, max-age=0, s-maxage=30',
        },
      }),
    );
    expect(await probe.head()).toEqual({
      kind: 'present',
      status: 200,
      generatedAtMs: Date.parse('2026-07-14T10:15:00Z'),
      lastModifiedMs: Date.parse('2026-07-14T10:15:02Z'),
      etag: '"e1"',
      cacheControl: 'public, max-age=0, s-maxage=30',
    });
  });

  it('treats an unparseable stamp as absent, not as now', async () => {
    const { probe } = respond(
      new Response(null, { status: 200, headers: { 'x-amz-meta-generated-at': 'yesterday' } }),
    );
    expect(await probe.head()).toMatchObject({ generatedAtMs: null, lastModifiedMs: null });
  });

  it.each([404, 410])('reads HTTP %i as missing', async (status) => {
    expect(await respond(new Response(null, { status })).probe.head()).toEqual({
      kind: 'missing',
      status,
    });
  });

  it('reads any other failure as unreachable, never throwing', async () => {
    expect(await respond(new Response(null, { status: 503 })).probe.head()).toEqual({
      kind: 'unreachable',
      reason: 'HTTP 503',
    });
    expect(await respond(new TypeError('fetch failed')).probe.head()).toEqual({
      kind: 'unreachable',
      reason: 'TypeError: fetch failed',
    });
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    expect(await respond(timeout).probe.head()).toEqual({
      kind: 'unreachable',
      reason: 'timed out',
    });
  });
});
