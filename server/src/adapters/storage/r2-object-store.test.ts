import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type { ObjectToStore } from '../../core/ports/object-store.js';
import { createR2ObjectStore, parseHttpDate, readHead } from './r2-object-store.js';
import { sha256Hex } from './s3-sigv4.js';

const ACCESS_KEY_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SECRET = 'Zm9vYmFyYmF6cXV4c2VjcmV0c2VjcmV0c2VjcmV0MTI=';
const ENDPOINT = 'https://acct123.eu.r2.cloudflarestorage.com';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: input instanceof Request ? input.url : input.toString(), init };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

function store(fetchFn: typeof fetch) {
  return createR2ObjectStore({
    endpoint: ENDPOINT,
    bucket: 'fire-watch-t2',
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET },
    clock: new VirtualClock('2026-07-14T10:15:00Z'),
    fetch: fetchFn,
  });
}

const OBJECT: ObjectToStore = {
  key: 'snapshot.json',
  body: '{"type":"FeatureCollection","generated_at":"2026-07-14T10:15:00Z"}',
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'public, max-age=0, s-maxage=30',
  metadata: { 'generated-at': '2026-07-14T10:15:00Z', 'max-seq': '12' },
};

function headers(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('createR2ObjectStore.put', () => {
  it('sends one signed, path-style PUT carrying the exact bytes and their hash', async () => {
    const fake = fakeFetch(() => new Response(null, { status: 200, headers: { etag: '"e1"' } }));
    const result = await store(fake.fetch).put(OBJECT);

    expect(result).toEqual({ etag: '"e1"' });
    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.calls[0] ?? { url: '', init: {} };
    expect(url).toBe(`${ENDPOINT}/fire-watch-t2/snapshot.json`);
    expect(init.method).toBe('PUT');
    expect(init.redirect).toBe('error');
    expect(Buffer.from(init.body as Buffer).toString('utf8')).toBe(OBJECT.body);

    const sent = headers(init);
    expect(sent['host']).toBeUndefined();
    expect(sent['x-amz-content-sha256']).toBe(sha256Hex(OBJECT.body));
    expect(sent['x-amz-date']).toBe('20260714T101500Z');
    expect(sent['content-type']).toBe(OBJECT.contentType);
    expect(sent['cache-control']).toBe(OBJECT.cacheControl);
    expect(sent['x-amz-meta-generated-at']).toBe('2026-07-14T10:15:00Z');
    expect(sent['x-amz-meta-max-seq']).toBe('12');
    expect(sent['authorization']).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/20260714/auto/s3/aws4_request,` +
          'SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date;' +
          'x-amz-meta-generated-at;x-amz-meta-max-seq,Signature=[0-9a-f]{64}$',
      ),
    );
  });

  it('never sends or reports the secret', async () => {
    const fake = fakeFetch(
      () =>
        new Response(`<Error><Code>AccessDenied</Code><Message>${SECRET}</Message></Error>`, {
          status: 403,
        }),
    );
    const error = await store(fake.fetch)
      .put(OBJECT)
      .then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
    expect(error?.message).toBe('R2 PUT snapshot.json failed: HTTP 403 AccessDenied');
    expect(JSON.stringify(fake.calls)).not.toContain(SECRET);
    expect(error?.message).not.toContain(SECRET);
    expect(error?.message).not.toContain(ACCESS_KEY_ID);
  });

  it('reports the status alone when the body has no S3 error code', async () => {
    const fake = fakeFetch(() => new Response('upstream sad', { status: 502 }));
    await expect(store(fake.fetch).put(OBJECT)).rejects.toThrow(
      /^R2 PUT snapshot.json failed: HTTP 502$/,
    );
  });

  it('wraps a network failure without leaking the request', async () => {
    const failing = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(store(failing).put(OBJECT)).rejects.toThrow(
      'R2 PUT snapshot.json failed: TypeError: fetch failed',
    );
  });

  it('refuses metadata that would not survive as a header', async () => {
    const fake = fakeFetch(() => new Response(null, { status: 200 }));
    await expect(store(fake.fetch).put({ ...OBJECT, metadata: { Bad_Name: 'x' } })).rejects.toThrow(
      RangeError,
    );
    await expect(
      store(fake.fetch).put({ ...OBJECT, metadata: { note: 'line\nbreak' } }),
    ).rejects.toThrow(RangeError);
    expect(fake.calls).toEqual([]);
  });
});

describe('createR2ObjectStore.head', () => {
  it('reads the stored head, metadata included', async () => {
    const fake = fakeFetch(
      () =>
        new Response(null, {
          status: 200,
          headers: {
            etag: '"e1"',
            'content-length': '64',
            'last-modified': 'Tue, 14 Jul 2026 10:15:01 GMT',
            'x-amz-meta-generated-at': '2026-07-14T10:15:00Z',
          },
        }),
    );
    const head = await store(fake.fetch).head('snapshot.json');
    expect(fake.calls[0]?.init.method).toBe('HEAD');
    expect(headers(fake.calls[0]?.init ?? {})['x-amz-content-sha256']).toBe(sha256Hex(''));
    expect(head).toEqual({
      etag: '"e1"',
      contentLength: 64,
      lastModifiedMs: Date.parse('2026-07-14T10:15:01Z'),
      metadata: { 'generated-at': '2026-07-14T10:15:00Z' },
    });
  });

  it('is null for a missing object and throws on any other failure', async () => {
    await expect(
      store(fakeFetch(() => new Response(null, { status: 404 })).fetch).head('x.json'),
    ).resolves.toBeNull();
    await expect(
      store(fakeFetch(() => new Response(null, { status: 500 })).fetch).head('x.json'),
    ).rejects.toThrow('R2 HEAD x.json failed: HTTP 500');
  });
});

describe('header parsing', () => {
  it('parses only a strict IMF-fixdate', () => {
    expect(parseHttpDate('Sun, 06 Nov 1994 08:49:37 GMT')).toBe(Date.UTC(1994, 10, 6, 8, 49, 37));
    expect(parseHttpDate('Sunday, 06-Nov-94 08:49:37 GMT')).toBeNull();
    expect(parseHttpDate('2026-07-14T10:15:00Z')).toBeNull();
    expect(parseHttpDate(null)).toBeNull();
  });

  it('treats a malformed content-length as unknown', () => {
    const head = readHead(new Headers({ 'content-length': '12abc' }));
    expect(head).toEqual({ etag: null, contentLength: null, lastModifiedMs: null, metadata: {} });
  });
});
