/** The GWIS point client: URL, value-style failures, body cap. No socket is opened. */

import { describe, expect, it } from 'vitest';

import { createGwisPointClient, GWIS_POINT_MAX_BODY_BYTES } from './gwis-point-client.js';

function fetchReturning(
  response: Response | Error,
): typeof globalThis.fetch & { readonly urls: string[] } {
  const urls: string[] = [];
  const fn = (input: string | URL | Request): Promise<Response> => {
    urls.push(input instanceof Request ? input.url : String(input));
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  };
  return Object.assign(fn, { urls });
}

describe('createGwisPointClient', () => {
  it('serializes the core query against the GWIS base and hands back the body', async () => {
    const fetch = fetchReturning(new Response('<table></table>', { status: 200 }));
    const client = createGwisPointClient({ baseUrl: 'https://gwis.test/gwis/', fetch });
    const result = await client.fetchPoint({ query: { REQUEST: 'GetFeatureInfo', TIME: 'x' } });
    expect(fetch.urls).toEqual(['https://gwis.test/gwis?REQUEST=GetFeatureInfo&TIME=x']);
    expect(result).toEqual({ body: '<table></table>', error: null });
  });

  it('keeps an empty 200 as an empty body (the past-horizon answer)', async () => {
    const client = createGwisPointClient({
      fetch: fetchReturning(new Response('', { status: 200 })),
    });
    expect(await client.fetchPoint({ query: {} })).toEqual({ body: '', error: null });
  });

  it('turns a non-200, a network error and an oversized body into values', async () => {
    const non200 = createGwisPointClient({
      fetch: fetchReturning(new Response('nope', { status: 502 })),
    });
    expect((await non200.fetchPoint({ query: {} })).body).toBeNull();
    const broken = createGwisPointClient({ fetch: fetchReturning(new Error('reset')) });
    expect(await broken.fetchPoint({ query: {} })).toEqual({
      body: null,
      error: 'GWIS point request failed: reset',
    });
    const huge = createGwisPointClient({
      fetch: fetchReturning(new Response('x'.repeat(GWIS_POINT_MAX_BODY_BYTES + 1))),
    });
    expect((await huge.fetchPoint({ query: {} })).body).toBeNull();
  });
});
