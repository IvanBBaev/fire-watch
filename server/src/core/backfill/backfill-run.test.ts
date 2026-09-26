import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import { VirtualClock } from '../ports/clock.js';
import type { ArchiveStore, ArchiveWriteResult } from '../ports/archive-store.js';
import type { FirmsAreaClient, FirmsAreaQuery } from '../ports/firms-client.js';
import type { Sleeper } from '../ports/sleeper.js';
import { emptyManifest, parseManifest, renderManifest } from './backfill-manifest.js';
import { backfillJob, type BackfillJob, type BackfillSourceSpec } from './backfill-plan.js';
import { checkArchive, runBackfill, type BackfillRunDeps } from './backfill-run.js';

const SPEC: BackfillSourceSpec = {
  source: 'firms:viirs:snpp',
  product: 'VIIRS_SNPP_SP',
  firstDay: '2024-01-01',
  lastDay: '2024-01-25', // 10 + 10 + 5 → three chunks
};

function testJob(): BackfillJob {
  return backfillJob(
    defineConfig('firms_sp_backfill', 'firms_sp_backfill_test_v1', { sources: [SPEC] }),
  );
}

const CSV = 'latitude,longitude,acq_date\n42.10000,24.70000,2024-01-01\n';

/**
 * The port's in-memory double. Its "hash" is deliberately not sha256 — the runner treats
 * hashes as opaque strings it records and compares, and the fs adapter's own test is
 * where real sha256 is asserted.
 */
class MemoryStore implements ArchiveStore {
  readonly files = new Map<string, string>();
  manifest: string | null = null;
  manifestWrites = 0;

  fileSize(relativePath: string): Promise<number | null> {
    const contents = this.files.get(relativePath);
    return Promise.resolve(contents === undefined ? null : Buffer.byteLength(contents, 'utf8'));
  }

  fileSha256(relativePath: string): Promise<string | null> {
    const contents = this.files.get(relativePath);
    return Promise.resolve(contents === undefined ? null : fakeHash(contents));
  }

  writeFile(relativePath: string, contents: string): Promise<ArchiveWriteResult> {
    this.files.set(relativePath, contents);
    return Promise.resolve({
      bytes: Buffer.byteLength(contents, 'utf8'),
      sha256: fakeHash(contents),
    });
  }

  readManifest(): Promise<string | null> {
    return Promise.resolve(this.manifest);
  }

  writeManifest(text: string): Promise<void> {
    this.manifest = text;
    this.manifestWrites += 1;
    return Promise.resolve();
  }
}

/** 64 hex characters derived from the content — stable, obviously not real sha256. */
function fakeHash(contents: string): string {
  let hash = 0;
  for (let i = 0; i < contents.length; i += 1) {
    hash = (Math.imul(hash, 31) + contents.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
}

function stubClient(handler: (query: FirmsAreaQuery) => string | Error): {
  readonly queries: FirmsAreaQuery[];
  readonly client: FirmsAreaClient;
} {
  const queries: FirmsAreaQuery[] = [];
  return {
    queries,
    client: {
      fetchArea(query: FirmsAreaQuery) {
        queries.push(query);
        const outcome = handler(query);
        return outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve({ csv: outcome, availableAt: 0 });
      },
    },
  };
}

function recordingSleeper(): { readonly sleeps: number[]; readonly sleeper: Sleeper } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleeper: {
      sleep(ms: number): Promise<void> {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

function makeDeps(
  store: MemoryStore,
  client: FirmsAreaClient,
  overrides: Partial<BackfillRunDeps> = {},
): { deps: BackfillRunDeps; lines: string[]; sleeps: number[] } {
  const lines: string[] = [];
  const { sleeps, sleeper } = recordingSleeper();
  return {
    lines,
    sleeps,
    deps: {
      client,
      store,
      clock: new VirtualClock('2026-08-12T09:00:00Z'),
      sleeper,
      signal: new AbortController().signal,
      delayMs: 5_000,
      writeLine: (line) => lines.push(line),
      ...overrides,
    },
  };
}

describe('runBackfill', () => {
  it('downloads every chunk of a fresh archive and persists the manifest per chunk', async () => {
    const job = testJob();
    const store = new MemoryStore();
    const { client, queries } = stubClient(() => CSV);
    const { deps, lines } = makeDeps(store, client);

    const summary = await runBackfill(job, deps);

    expect(summary).toEqual({ planned: 3, downloaded: 3, skipped: 0, failed: 0, aborted: false });
    expect(queries.map((query) => query.startDate)).toEqual([
      '2024-01-01',
      '2024-01-11',
      '2024-01-21',
    ]);
    expect(store.files.size).toBe(3);
    expect(store.manifestWrites).toBe(3);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"status":"downloaded"');
    // The persisted manifest parses back under the same job and vouches for every chunk.
    const manifest = parseManifest(store.manifest ?? '', job);
    expect(Object.values(manifest.chunks).every((entry) => entry.status === 'complete')).toBe(true);
    expect(Object.values(manifest.chunks)[0]?.fetched_at).toBe('2026-08-12T09:00:00Z');
  });

  it('resumes: chunks the manifest vouches for are skipped without a request', async () => {
    const job = testJob();
    const store = new MemoryStore();
    const first = stubClient(() => CSV);
    await runBackfill(job, makeDeps(store, first.client).deps);

    const second = stubClient(() => new Error('the resumed run must not hit the network'));
    const { deps, lines } = makeDeps(store, second.client);
    const summary = await runBackfill(job, deps);

    expect(summary).toEqual({ planned: 3, downloaded: 0, skipped: 3, failed: 0, aborted: false });
    expect(second.queries).toHaveLength(0);
    expect(lines.every((line) => line.includes('"status":"skipped"'))).toBe(true);
  });

  it('re-downloads a chunk whose file is gone or the wrong size, complete entry or not', async () => {
    const job = testJob();
    const store = new MemoryStore();
    const first = stubClient(() => CSV);
    await runBackfill(job, makeDeps(store, first.client).deps);

    const chunk0 = job.chunks[0];
    const chunk1 = job.chunks[1];
    if (chunk0 === undefined || chunk1 === undefined) throw new Error('job has no chunks');
    store.files.delete(chunk0.relativePath); // crash between rename and manifest? deleted by hand?
    store.files.set(chunk1.relativePath, 'latitude,'); // truncated: size disagrees with manifest

    const second = stubClient(() => CSV);
    const summary = await runBackfill(job, makeDeps(store, second.client).deps);

    expect(summary).toEqual({ planned: 3, downloaded: 2, skipped: 1, failed: 0, aborted: false });
    expect(second.queries.map((query) => query.startDate)).toEqual(['2024-01-01', '2024-01-11']);
    expect(store.files.get(chunk1.relativePath)).toBe(CSV);
  });

  it('records a fetch failure and keeps walking', async () => {
    const job = testJob();
    const store = new MemoryStore();
    const { client } = stubClient((query) =>
      query.startDate === '2024-01-11' ? new Error('FIRMS returned 503 for VIIRS_SNPP_SP') : CSV,
    );
    const { deps, lines } = makeDeps(store, client);

    const summary = await runBackfill(job, deps);

    expect(summary).toEqual({ planned: 3, downloaded: 2, skipped: 0, failed: 1, aborted: false });
    const manifest = parseManifest(store.manifest ?? '', job);
    const failed = Object.values(manifest.chunks).find((entry) => entry.status === 'failed');
    expect(failed?.error).toContain('503');
    expect(lines.filter((line) => line.includes('"status":"failed"'))).toHaveLength(1);
  });

  it('refuses a 200 that is not detection CSV and writes nothing for it', async () => {
    const job = testJob();
    const store = new MemoryStore();
    const { client } = stubClient((query) =>
      query.startDate === '2024-01-01'
        ? 'You have exceeded your transaction limit. Please wait.'
        : CSV,
    );
    const { deps } = makeDeps(store, client);

    const summary = await runBackfill(job, deps);

    expect(summary.failed).toBe(1);
    expect(summary.downloaded).toBe(2);
    const chunk0 = job.chunks[0];
    expect(store.files.has(chunk0?.relativePath ?? '')).toBe(false);
    const manifest = parseManifest(store.manifest ?? '', job);
    expect(manifest.chunks[chunk0?.chunkId ?? '']?.error).toContain('not fire-detection CSV');
  });

  it('pauses between requests, never before the first and never after a skip', async () => {
    const job = testJob();
    const store = new MemoryStore();
    // Pre-complete the middle chunk so the walk is request, skip, request.
    const seed = stubClient(() => CSV);
    await runBackfill(job, makeDeps(store, seed.client).deps);
    const chunk0 = job.chunks[0];
    const chunk2 = job.chunks[2];
    if (chunk0 === undefined || chunk2 === undefined) throw new Error('job has no chunks');
    store.files.delete(chunk0.relativePath);
    store.files.delete(chunk2.relativePath);

    const { client, queries } = stubClient(() => CSV);
    const { deps, sleeps } = makeDeps(store, client);
    await runBackfill(job, deps);

    expect(queries).toHaveLength(2);
    expect(sleeps).toEqual([5_000]); // n requests, n−1 pauses; the skip cost nothing
  });

  it('stops at an abort and reports the walk as aborted, manifest intact', async () => {
    const job = testJob();
    const store = new MemoryStore();
    const controller = new AbortController();
    const { client, queries } = stubClient(() => {
      controller.abort(); // arrives while the first chunk is in flight
      return CSV;
    });
    const { deps } = makeDeps(store, client, { signal: controller.signal });

    const summary = await runBackfill(job, deps);

    expect(queries).toHaveLength(1);
    expect(summary).toEqual({ planned: 3, downloaded: 1, skipped: 0, failed: 0, aborted: true });
    // The chunk that was in flight when the signal arrived is still recorded.
    const manifest = parseManifest(store.manifest ?? '', job);
    expect(Object.keys(manifest.chunks)).toHaveLength(1);
  });

  it('refuses to run over a manifest from a different plan', async () => {
    const job = testJob();
    const store = new MemoryStore();
    const otherJob = backfillJob(
      defineConfig('firms_sp_backfill', 'firms_sp_backfill_other_v1', {
        sources: [{ ...SPEC, lastDay: '2024-01-10' }],
      }),
    );
    store.manifest = renderManifest(emptyManifest(otherJob));

    const { client } = stubClient(() => CSV);
    await expect(runBackfill(job, makeDeps(store, client).deps)).rejects.toThrow(/plan/);
  });
});

describe('checkArchive', () => {
  async function archivedJob(): Promise<{ job: BackfillJob; store: MemoryStore }> {
    const job = testJob();
    const store = new MemoryStore();
    const { client } = stubClient(() => CSV);
    await runBackfill(job, makeDeps(store, client).deps);
    return { job, store };
  }

  it('verifies every complete entry against its recorded hash, no network involved', async () => {
    const { job, store } = await archivedJob();
    const lines: string[] = [];

    const summary = await checkArchive(job, { store, writeLine: (line) => lines.push(line) });

    expect(summary).toEqual({ entries: 3, ok: 3, mismatched: 0, missing: 0 });
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.includes('"status":"ok"'))).toBe(true);
  });

  it('reports corrupted and missing files by chunk', async () => {
    const { job, store } = await archivedJob();
    const chunk0 = job.chunks[0];
    const chunk1 = job.chunks[1];
    if (chunk0 === undefined || chunk1 === undefined) throw new Error('job has no chunks');
    store.files.set(chunk0.relativePath, `${CSV}42.2,24.8,2024-01-02\n`); // silently altered
    store.files.delete(chunk1.relativePath);
    const lines: string[] = [];

    const summary = await checkArchive(job, { store, writeLine: (line) => lines.push(line) });

    expect(summary).toEqual({ entries: 3, ok: 1, mismatched: 1, missing: 1 });
    expect(lines.find((line) => line.includes(chunk0.chunkId))).toContain('sha256_mismatch');
    expect(lines.find((line) => line.includes(chunk1.chunkId))).toContain('"status":"missing"');
  });

  it('ignores failed entries — there is nothing on disk to verify for them', async () => {
    const job = testJob();
    const store = new MemoryStore();
    const { client } = stubClient((query) =>
      query.startDate === '2024-01-01' ? new Error('FIRMS returned 503') : CSV,
    );
    await runBackfill(job, makeDeps(store, client).deps);

    const summary = await checkArchive(job, { store, writeLine: () => undefined });

    expect(summary).toEqual({ entries: 2, ok: 2, mismatched: 0, missing: 0 });
  });

  it('refuses a fresh archive: nothing to check is an answer, not a pass', async () => {
    const job = testJob();
    const store = new MemoryStore();

    await expect(checkArchive(job, { store, writeLine: () => undefined })).rejects.toThrow(
      /no manifest/,
    );
  });
});
