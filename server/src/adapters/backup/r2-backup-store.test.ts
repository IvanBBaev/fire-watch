import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { afterAll, describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import { createR2BackupStore, parseListObjectsV2 } from './r2-backup-store.js';

const dir = mkdtempSync(join(tmpdir(), 'fw-r2-backup-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE0000000000',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const KEY = 'fw-main/daily/2026/09/24/fire-watch-main-20260924T022000Z.dump.age';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit & { duplex?: string }) => {
    let body: string | null = null;
    if (init.body !== undefined && init.body !== null) {
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as unknown as Readable)
        chunks.push(Buffer.from(chunk as Buffer));
      body = Buffer.concat(chunks).toString('utf8');
      expect(init.duplex).toBe('half');
    }
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body,
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function store(fetch: typeof globalThis.fetch) {
  return createR2BackupStore({
    endpoint: 'https://acct.eu.r2.cloudflarestorage.com',
    bucket: 'fire-watch-backups',
    credentials: CREDENTIALS,
    clock: new VirtualClock('2026-09-24T02:25:00Z'),
    fetch,
  });
}

describe('upload', () => {
  it('streams the file, signs its sha256 as the payload hash, sends metadata', async () => {
    const path = join(dir, 'artifact.age');
    writeFileSync(path, 'encrypted-bytes');
    const sha256 = createHash('sha256').update('encrypted-bytes').digest('hex');
    const f = fakeFetch(() => new Response(null, { status: 200, headers: { etag: '"abc"' } }));
    const result = await store(f.fetch).upload(
      KEY,
      { path, bytes: 15, sha256 },
      { 'backup-set': 'main', sha256 },
    );
    expect(result).toEqual({ etag: '"abc"' });
    const [call] = f.calls;
    expect(call?.method).toBe('PUT');
    expect(call?.url).toBe(`https://acct.eu.r2.cloudflarestorage.com/fire-watch-backups/${KEY}`);
    expect(call?.body).toBe('encrypted-bytes');
    expect(call?.headers).toMatchObject({
      'x-amz-content-sha256': sha256,
      'content-length': '15',
      'x-amz-meta-backup-set': 'main',
      'x-amz-meta-sha256': sha256,
    });
    expect(call?.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/);
    expect(call?.headers['authorization']).not.toContain(CREDENTIALS.secretAccessKey);
  });

  it('reports status and S3 code only, never the body', async () => {
    const path = join(dir, 'artifact2.age');
    writeFileSync(path, 'x');
    const f = fakeFetch(
      () =>
        new Response(
          '<Error><Code>AccessDenied</Code><Message>AKIDEXAMPLE secret</Message></Error>',
          {
            status: 403,
          },
        ),
    );
    const error = await store(f.fetch)
      .upload(KEY, { path, bytes: 1, sha256: 'a'.repeat(64) }, {})
      .then(
        () => new Error('resolved unexpectedly'),
        (e: unknown) => e as Error,
      );
    expect(error.message).toBe(`R2 PUT ${KEY} failed: HTTP 403 AccessDenied`);
  });

  it('refuses unsafe metadata and a missing sha256 before sending', async () => {
    const f = fakeFetch(() => new Response(null));
    const s = store(f.fetch);
    await expect(
      s.upload(KEY, { path: '/nope', bytes: 1, sha256: 'a'.repeat(64) }, { Bad_Name: 'x' }),
    ).rejects.toThrow(RangeError);
    await expect(s.upload(KEY, { path: '/nope', bytes: 1, sha256: 'nope' }, {})).rejects.toThrow(
      /sha256/,
    );
    expect(f.calls).toEqual([]);
  });
});

describe('list', () => {
  it('pages through ListObjectsV2 with a signed canonical query', async () => {
    const pages = [
      `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t+1/=</NextContinuationToken>
        <Contents><Key>${KEY}</Key><LastModified>2026-09-24T02:30:00.000Z</LastModified><Size>1234</Size></Contents>
      </ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated>
        <Contents><Key>fw-main/a&amp;b</Key><LastModified>bogus</LastModified><Size>x</Size></Contents>
      </ListBucketResult>`,
    ];
    let page = 0;
    const f = fakeFetch(() => new Response(pages[page++] ?? ''));
    const listed = await store(f.fetch).list('fw-main/');
    expect(listed).toEqual([
      { key: KEY, lastModifiedMs: Date.parse('2026-09-24T02:30:00.000Z'), sizeBytes: 1234 },
      { key: 'fw-main/a&b', lastModifiedMs: null, sizeBytes: null },
    ]);
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://acct.eu.r2.cloudflarestorage.com/fire-watch-backups?list-type=2&prefix=fw-main%2F',
      'https://acct.eu.r2.cloudflarestorage.com/fire-watch-backups?continuation-token=t%2B1%2F%3D&list-type=2&prefix=fw-main%2F',
    ]);
  });

  it('fails on an error status', async () => {
    const f = fakeFetch(
      () => new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 }),
    );
    await expect(store(f.fetch).list('fw-main/')).rejects.toThrow('HTTP 404 NoSuchBucket');
  });
});

describe('download', () => {
  it('streams to a 0600 file, hashes it, and returns the recorded sha256', async () => {
    const recorded = createHash('sha256').update('payload').digest('hex');
    const f = fakeFetch(
      () => new Response('payload', { headers: { 'x-amz-meta-sha256': recorded } }),
    );
    const dest = join(dir, 'down.age');
    const fetched = await store(f.fetch).download(KEY, dest);
    expect(fetched).toEqual({
      key: KEY,
      path: dest,
      bytes: 7,
      sha256: recorded,
      recordedSha256: recorded,
    });
    expect(readFileSync(dest, 'utf8')).toBe('payload');
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });

  it('returns null on 404 and a null recorded hash when metadata is absent or malformed', async () => {
    const missing = fakeFetch(() => new Response(null, { status: 404 }));
    await expect(store(missing.fetch).download(KEY, join(dir, 'none.age'))).resolves.toBeNull();

    const bad = fakeFetch(() => new Response('p', { headers: { 'x-amz-meta-sha256': 'zz' } }));
    const fetched = await store(bad.fetch).download(KEY, join(dir, 'bad.age'));
    expect(fetched?.recordedSha256).toBeNull();
  });

  it('never overwrites an existing file', async () => {
    const dest = join(dir, 'exists.age');
    writeFileSync(dest, 'keep');
    const f = fakeFetch(() => new Response('new'));
    await expect(store(f.fetch).download(KEY, dest)).rejects.toThrow(/EEXIST/);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('keep');
  });
});

describe('parseListObjectsV2', () => {
  it('ignores an IsTruncated inside a Contents block', () => {
    expect(
      parseListObjectsV2('<R><Contents><Key>k</Key><IsTruncated>true</IsTruncated></Contents></R>')
        .truncated,
    ).toBe(false);
  });
});
