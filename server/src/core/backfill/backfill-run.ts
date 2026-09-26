/**
 * The backfill runner (TASKS B8): walks the plan sequentially, downloads what the
 * manifest does not already vouch for, and re-verifies hashes on demand.
 *
 * Single-flight on purpose. FIRMS's quota (5,000 transactions per 10 minutes) makes
 * parallelism pointless for 666 requests, and a polite serial walk with a fixed delay is
 * the difference between an archive job a data provider tolerates and one that gets a
 * key throttled. The delay sits *between* requests — the first one goes immediately, so
 * `--check`-then-run loops and resumed runs with nothing left to do never wait at all.
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import type { ArchiveStore } from '../ports/archive-store.js';
import { isoFromEpochMs, type Clock } from '../ports/clock.js';
import type { FirmsAreaClient } from '../ports/firms-client.js';
import type { Sleeper } from '../ports/sleeper.js';
import {
  completedEntry,
  emptyManifest,
  parseManifest,
  renderManifest,
  withEntry,
  type BackfillManifest,
  type ManifestEntry,
} from './backfill-manifest.js';
import { chunkQuery, type BackfillChunk, type BackfillJob } from './backfill-plan.js';

export interface BackfillRunDeps {
  readonly client: FirmsAreaClient;
  readonly store: ArchiveStore;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly signal: AbortSignal;
  /** Politeness pause between consecutive requests, milliseconds. */
  readonly delayMs: number;
  /** One canonical-JSON line per chunk — the run's progress protocol on stdout. */
  readonly writeLine: (line: string) => void;
}

export interface BackfillSummary {
  readonly planned: number;
  readonly downloaded: number;
  readonly skipped: number;
  readonly failed: number;
  /** True when SIGTERM/SIGINT stopped the walk early; the manifest is still consistent. */
  readonly aborted: boolean;
}

export async function runBackfill(
  job: BackfillJob,
  deps: BackfillRunDeps,
): Promise<BackfillSummary> {
  let manifest = await loadManifest(job, deps.store);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let aborted = false;
  let requested = false;

  for (const chunk of job.chunks) {
    if (deps.signal.aborted) {
      aborted = true;
      break;
    }

    if (await isAlreadyArchived(manifest, chunk, deps.store)) {
      skipped += 1;
      reportChunk(deps.writeLine, chunk, 'skipped');
      continue;
    }

    // The pause precedes the request, not the chunk — skips are free, and an abort that
    // lands mid-sleep must not be followed by one last request.
    if (requested) {
      await deps.sleeper.sleep(deps.delayMs, deps.signal);
      if (deps.signal.aborted) {
        aborted = true;
        break;
      }
    }
    requested = true;

    const entry = await downloadChunk(job, chunk, deps);
    manifest = withEntry(manifest, chunk.chunkId, entry);
    // Persisted after every chunk: the manifest a crash leaves behind is at most one
    // chunk behind reality, and that chunk is an orphan file, never a false "complete".
    await deps.store.writeManifest(renderManifest(manifest));

    if (entry.status === 'complete') {
      downloaded += 1;
      reportChunk(deps.writeLine, chunk, 'downloaded', {
        ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
        ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
      });
    } else {
      failed += 1;
      reportChunk(deps.writeLine, chunk, 'failed', {
        ...(entry.error === undefined ? {} : { error: entry.error }),
      });
    }
  }

  return { planned: job.chunks.length, downloaded, skipped, failed, aborted };
}

export interface CheckDeps {
  readonly store: ArchiveStore;
  readonly writeLine: (line: string) => void;
}

export interface CheckSummary {
  /** `complete` manifest entries examined. */
  readonly entries: number;
  readonly ok: number;
  readonly mismatched: number;
  readonly missing: number;
}

/**
 * Re-hashes every file the manifest calls complete and compares against the recorded
 * sha256 — no network, no key. This is the periodic integrity pass OPERATIONS §6 asks
 * for on anything that exists in one copy.
 */
export async function checkArchive(job: BackfillJob, deps: CheckDeps): Promise<CheckSummary> {
  const text = await deps.store.readManifest();
  if (text === null) {
    throw new Error('nothing to check: the archive has no manifest — run the backfill first');
  }
  const manifest = parseManifest(text, job);

  let entries = 0;
  let ok = 0;
  let mismatched = 0;
  let missing = 0;

  for (const [chunkId, entry] of Object.entries(manifest.chunks).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (entry.status !== 'complete') continue;
    entries += 1;
    const actual = await deps.store.fileSha256(entry.path);
    const status = actual === null ? 'missing' : actual === entry.sha256 ? 'ok' : 'sha256_mismatch';
    if (status === 'ok') ok += 1;
    else if (status === 'missing') missing += 1;
    else mismatched += 1;
    deps.writeLine(canonicalJson({ backfill_check: { chunk: chunkId, path: entry.path, status } }));
  }

  return { entries, ok, mismatched, missing };
}

async function loadManifest(job: BackfillJob, store: ArchiveStore): Promise<BackfillManifest> {
  const text = await store.readManifest();
  return text === null ? emptyManifest(job) : parseManifest(text, job);
}

/**
 * Skip only when the manifest says complete *and* the bytes on disk agree with it.
 * A missing or size-mismatched file under a complete entry means the archive and the
 * manifest have diverged (manual deletion, partial restore) — re-download, don't trust.
 */
async function isAlreadyArchived(
  manifest: BackfillManifest,
  chunk: BackfillChunk,
  store: ArchiveStore,
): Promise<boolean> {
  const entry = completedEntry(manifest, chunk);
  if (entry === null) return false;
  const size = await store.fileSize(entry.path);
  return size !== null && size === entry.bytes;
}

async function downloadChunk(
  job: BackfillJob,
  chunk: BackfillChunk,
  deps: BackfillRunDeps,
): Promise<ManifestEntry> {
  const base = {
    source: chunk.source,
    product: chunk.product,
    start_date: chunk.startDate,
    day_range: chunk.dayRange,
    path: chunk.relativePath,
  };
  try {
    const response = await deps.client.fetchArea(chunkQuery(chunk, job.area));
    // FIRMS serves quota and error notices as HTTP 200 text (DATA-SOURCES §A1.1 pitfall
    // 4), so a 200 body is only a CSV if it says so. Archiving a notice as data would
    // pass every hash check forever — refuse it here, while it is still recognizable.
    const newline = response.csv.indexOf('\n');
    const header = newline === -1 ? response.csv : response.csv.slice(0, newline);
    if (!header.includes('latitude') || !header.includes('longitude')) {
      return {
        ...base,
        status: 'failed',
        fetched_at: isoFromEpochMs(deps.clock.now()),
        error: 'response is not fire-detection CSV (rate-limit or service notice)',
      };
    }
    const written = await deps.store.writeFile(chunk.relativePath, response.csv);
    return {
      ...base,
      status: 'complete',
      fetched_at: isoFromEpochMs(deps.clock.now()),
      bytes: written.bytes,
      sha256: written.sha256,
    };
  } catch (error) {
    // The client redacts its own errors (the key never leaves the adapter); recording
    // the message and moving on lets a transient failure cost one chunk, not the run.
    return {
      ...base,
      status: 'failed',
      fetched_at: isoFromEpochMs(deps.clock.now()),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function reportChunk(
  writeLine: (line: string) => void,
  chunk: BackfillChunk,
  status: 'downloaded' | 'skipped' | 'failed',
  extra: { bytes?: number; sha256?: string; error?: string } = {},
): void {
  writeLine(
    canonicalJson({
      backfill_chunk: {
        chunk: chunk.chunkId,
        source: chunk.source,
        start_date: chunk.startDate,
        day_range: chunk.dayRange,
        path: chunk.relativePath,
        status,
        ...(extra.bytes === undefined ? {} : { bytes: extra.bytes }),
        ...(extra.sha256 === undefined ? {} : { sha256: extra.sha256 }),
        ...(extra.error === undefined ? {} : { error: extra.error }),
      },
    }),
  );
}
