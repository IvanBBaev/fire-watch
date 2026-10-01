import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { LightningProduct } from '../../core/ports/lightning-client.js';
import {
  EUMETSAT_API_BASE_URL,
  LFL_COLLECTION_ID,
  MAX_BODY_BYTES,
  SEARCH_PAGE_SIZE,
  TOKEN_EXPIRY_MARGIN_MS,
  createEumetsatDataStoreClient,
  lflSearchUrl,
  parseLflSearch,
  parseToken,
} from './eumetsat-datastore-client.js';

/** Two features trimmed from a real 2026-09-30 search answer (links reduced to sip-entries). */
const SEARCH = readFileSync(
  new URL('./__fixtures__/lfl-search.sample.json', import.meta.url),
  'utf8',
);

const NOW = Date.UTC(2026, 8, 30, 12, 40);
const WINDOW = { startIso: '2026-09-30T12:00:00Z', endIso: '2026-09-30T12:40:00Z' };
const CREDENTIALS = { consumerKey: 'key-123', consumerSecret: 'secret-456' };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function harness(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  clock = new VirtualClock(NOW),
) {
  const calls: Call[] = [];
  const client = createEumetsatDataStoreClient({
    credentials: CREDENTIALS,
    clock,
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url, init ?? {}));
    },
  });
  return { client, calls, clock };
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

const tokenResponse = (expiresIn = 3600, value = 'tok-abc') =>
  new Response(
    JSON.stringify({ access_token: value, token_type: 'Bearer', expires_in: expiresIn }),
    {
      status: 200,
    },
  );

/** Answers the fixture search, a token, and 5 bytes for any download. */
function upstream(url: string): Response {
  if (url.includes('/search-products/')) return new Response(SEARCH, { status: 200 });
  if (url.endsWith('/token')) return tokenResponse();
  return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });
}

describe('parseLflSearch', () => {
  it('reads each feature into a product with its BODY entry, wherever that entry sits', () => {
    const parsed = parseLflSearch(SEARCH);
    expect(parsed?.total).toBe(2);
    expect(parsed?.returned).toBe(2);
    const [first, second] = parsed!.products;
    expect(first?.product).toEqual({
      id: expect.stringContaining('_20260930122009_20260930123009_N__O_0075_0000') as unknown,
      window: { startIso: '2026-09-30T12:20:09Z', endIso: '2026-09-30T12:30:09Z' },
      publishedAtIso: '2026-09-30T12:30:47.877Z',
      md5: '041c99be56e84090dfd04b9ade629e3a',
      bodyName: expect.stringMatching(/LI-2-LFL--FD--CHK-BODY--.*_0075_0001\.nc$/) as unknown,
    });
    expect(first?.href.startsWith(`${EUMETSAT_API_BASE_URL}/data/download/`)).toBe(true);
    // In the real answer the BODY entry is first for one product and last for the other.
    expect(second?.product.bodyName).toMatch(/CHK-BODY--.*_0074_0001\.nc$/);
    expect(second?.product.bodyName).not.toMatch(/TRAIL/);
  });

  it('skips a feature of another product type or without a BODY entry, rather than guessing', () => {
    const raw = JSON.parse(SEARCH) as {
      features: { properties: Record<string, unknown> }[];
    };
    raw.features[0]!.properties['productInformation'] = { productType: 'MTILI2AF' };
    const links = raw.features[1]!.properties['links'] as { 'sip-entries': { title: string }[] };
    links['sip-entries'] = links['sip-entries'].filter((e) => !e.title.includes('CHK-BODY'));
    const parsed = parseLflSearch(JSON.stringify(raw));
    expect(parsed?.returned).toBe(2);
    expect(parsed?.products).toEqual([]);
  });

  it('drops an md5 that is not 32 hex characters and a malformed window', () => {
    const raw = JSON.parse(SEARCH) as { features: { properties: Record<string, unknown> }[] };
    raw.features[0]!.properties['extraInformation'] = { md5: 'nope' };
    raw.features[1]!.properties['date'] = '2026-09-30T12:10:09Z';
    const parsed = parseLflSearch(JSON.stringify(raw));
    expect(parsed?.products.map((p) => p.product.md5)).toEqual([null]);
  });

  it.each(['not json', '[]', '{"features": 3}'])('refuses %j', (text) => {
    expect(parseLflSearch(text)).toBeNull();
  });
});

describe('parseToken', () => {
  it('reads access_token and expires_in', () => {
    expect(parseToken('{"access_token":"a","expires_in":3600}')).toEqual({
      accessToken: 'a',
      expiresInSeconds: 3600,
    });
  });

  it.each(['{}', '{"access_token":""}', '{"access_token":"a b"}', 'x'])('refuses %j', (text) => {
    expect(parseToken(text)).toBeNull();
  });
});

describe('createEumetsatDataStoreClient', () => {
  it('searches the LFL collection anonymously with the window and a page size', async () => {
    const { client, calls } = harness(upstream);
    const found = await client.search(WINDOW);
    expect(found.ok && found.products).toHaveLength(2);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(
      `${EUMETSAT_API_BASE_URL}/data/search-products/1.0.0/os`,
    );
    expect(url.searchParams.get('pi')).toBe(LFL_COLLECTION_ID);
    expect(url.searchParams.get('dtstart')).toBe(WINDOW.startIso);
    expect(url.searchParams.get('dtend')).toBe(WINDOW.endIso);
    expect(url.searchParams.get('c')).toBe(String(SEARCH_PAGE_SIZE));
    expect(header(calls[0]!.init, 'authorization')).toBeUndefined();
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('follows the paging while a page is full and the total says there is more', async () => {
    const page = (count: number, total: number) =>
      JSON.stringify({ totalResults: total, features: Array.from({ length: count }, () => ({})) });
    const { client, calls } = harness((url) => {
      const si = Number(new URL(url).searchParams.get('si'));
      return new Response(si === 0 ? page(SEARCH_PAGE_SIZE, 130) : page(30, 130), { status: 200 });
    });
    const found = await client.search(WINDOW);
    expect(found.ok).toBe(true);
    expect(calls.map((c) => new URL(c.url).searchParams.get('si'))).toEqual([
      '0',
      String(SEARCH_PAGE_SIZE),
    ]);
  });

  it('reports a non-200 search with its status and a short excerpt', async () => {
    const { client } = harness(() => new Response('y'.repeat(900), { status: 503 }));
    const found = await client.search(WINDOW);
    expect(found).toEqual({
      ok: false,
      status: 503,
      error: expect.stringMatching(/^search returned 503/) as unknown,
    });
    expect(!found.ok && found.error.length).toBeLessThan(260);
  });

  it('asks for a token only on the first download, with Basic client credentials, and reuses it', async () => {
    const { client, calls } = harness(upstream);
    const found = await client.search(WINDOW);
    const products = found.ok ? found.products : [];
    const first = await client.downloadBody(products[0]!);
    const second = await client.downloadBody(products[1]!);
    expect(first).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      sha256: '74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0',
      availableAt: NOW,
    });
    expect(second.ok).toBe(true);
    const tokenCalls = calls.filter((c) => c.url.endsWith('/token'));
    expect(tokenCalls).toHaveLength(1);
    const init = tokenCalls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('grant_type=client_credentials');
    expect(header(init, 'authorization')).toBe(
      `Basic ${Buffer.from('key-123:secret-456').toString('base64')}`,
    );
    const downloads = calls.filter((c) => c.url.includes('/entry?'));
    expect(downloads.map((c) => header(c.init, 'authorization'))).toEqual([
      'Bearer tok-abc',
      'Bearer tok-abc',
    ]);
    expect(downloads.every((c) => c.init.redirect === 'manual')).toBe(true);
  });

  it('renews the token once it is within the margin of expiry', async () => {
    const { client, calls, clock } = harness(upstream);
    const found = await client.search(WINDOW);
    const product = found.ok ? found.products[0]! : null;
    await client.downloadBody(product!);
    clock.advanceMs(3600_000 - TOKEN_EXPIRY_MARGIN_MS);
    await client.downloadBody(product!);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(2);
  });

  it('drops the token after a 401 so the next download asks again', async () => {
    let downloads = 0;
    const { client, calls } = harness((url) => {
      if (url.includes('/entry?')) {
        downloads += 1;
        return new Response('expired', { status: downloads === 1 ? 401 : 200 });
      }
      return upstream(url);
    });
    const found = await client.search(WINDOW);
    const product = found.ok ? found.products[0]! : null;
    const refused = await client.downloadBody(product!);
    expect(refused).toEqual({
      ok: false,
      status: 401,
      error: expect.stringMatching(/download returned 401/) as unknown,
    });
    await client.downloadBody(product!);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(2);
  });

  it('reports a refused token without sending any download, and never echoes the secret', async () => {
    const { client, calls } = harness((url) =>
      url.endsWith('/token')
        ? new Response('{"error":"invalid_client"}', { status: 401 })
        : upstream(url),
    );
    const found = await client.search(WINDOW);
    const result = await client.downloadBody(
      found.ok ? found.products[0]! : ({} as LightningProduct),
    );
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: expect.stringMatching(/token endpoint returned 401/) as unknown,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-456|key-123/);
    expect(calls.some((c) => c.url.includes('/entry?'))).toBe(false);
  });

  it('never sends the token to a BODY link on another origin', async () => {
    const raw = JSON.parse(SEARCH) as {
      features: { properties: { links: { 'sip-entries': { href: string }[] } } }[];
    };
    for (const entry of raw.features[0]!.properties.links['sip-entries']) {
      entry.href = entry.href.replace(EUMETSAT_API_BASE_URL, 'https://collector.example');
    }
    const hostile = JSON.stringify(raw);
    const { client, calls } = harness((url) =>
      url.includes('/search-products/') ? new Response(hostile, { status: 200 }) : upstream(url),
    );
    const found = await client.search(WINDOW);
    const result = await client.downloadBody(
      found.ok ? found.products[0]! : ({} as LightningProduct),
    );
    expect(result).toEqual({
      ok: false,
      status: null,
      error: 'BODY link is not on the configured origin',
    });
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([EUMETSAT_API_BASE_URL]);
  });

  it('refuses a product it never saw in a search', async () => {
    const { client, calls } = harness(upstream);
    const result = await client.downloadBody({
      id: 'unknown',
      window: WINDOW,
      publishedAtIso: null,
      md5: null,
      bodyName: 'x.nc',
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports a redirect on a download as the non-200 it is', async () => {
    const { client, calls } = harness((url) =>
      url.includes('/entry?')
        ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } })
        : upstream(url),
    );
    const found = await client.search(WINDOW);
    const result = await client.downloadBody(
      found.ok ? found.products[0]! : ({} as LightningProduct),
    );
    expect(result).toMatchObject({ ok: false, status: 302 });
    expect(calls.some((c) => c.url.startsWith('https://elsewhere'))).toBe(false);
  });

  it('abandons a BODY that passes the byte cap', async () => {
    const { client } = harness((url) =>
      url.includes('/entry?')
        ? new Response(new Uint8Array(MAX_BODY_BYTES + 1), { status: 200 })
        : upstream(url),
    );
    const found = await client.search(WINDOW);
    const result = await client.downloadBody(
      found.ok ? found.products[0]! : ({} as LightningProduct),
    );
    expect(result).toEqual({ ok: false, status: null, error: 'BODY over the byte cap' });
  });

  it('turns a transport failure into status null', async () => {
    const client = createEumetsatDataStoreClient({
      credentials: CREDENTIALS,
      clock: new VirtualClock(NOW),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await client.search(WINDOW)).toEqual({
      ok: false,
      status: null,
      error: 'search request failed: fetch failed',
    });
  });
});

describe('lflSearchUrl', () => {
  it('encodes the collection id and the start index', () => {
    expect(lflSearchUrl(EUMETSAT_API_BASE_URL, WINDOW, 100)).toBe(
      `${EUMETSAT_API_BASE_URL}/data/search-products/1.0.0/os?format=json&pi=EO%3AEUM%3ADAT%3A0691&dtstart=2026-09-30T12%3A00%3A00Z&dtend=2026-09-30T12%3A40%3A00Z&c=100&si=100`,
    );
  });
});
