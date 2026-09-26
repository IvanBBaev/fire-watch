/**
 * The backfill integrity manifest (TASKS B8).
 *
 * One JSON document beside the files it describes: one entry per chunk, keyed by the
 * chunk id, carrying the target path, the byte count and sha256 of what was stored, and
 * when it was fetched. It is the single source of truth for "done" — a CSV on disk
 * without a `complete` entry is an orphan from an interrupted run, and the next run
 * re-downloads it.
 *
 * Rendered pretty-printed with sorted keys, because a human resumes this download after
 * a crash and needs to see where it stopped without tooling; updated by whole-document
 * rewrite through the store's atomic write, so a kill mid-update leaves the previous
 * manifest intact rather than a torn one that blocks every future resume.
 *
 * Entries the current plan does not know are preserved verbatim on rewrite — that is
 * what makes a plan *append* (a new source, a widened range) safe against an archive
 * that already exists.
 */

import type { BackfillChunk, BackfillJob } from './backfill-plan.js';

export const MANIFEST_VERSION = 1;

/** Relative to the archive root, beside the `firms/<product>/` trees it describes. */
export const MANIFEST_PATH = 'firms/sp-backfill-manifest.json';

export type ChunkStatus = 'complete' | 'failed';

export interface ManifestEntry {
  readonly source: string;
  readonly product: string;
  readonly start_date: string;
  readonly day_range: number;
  /** Relative to the archive root, exactly as the chunk planned it. */
  readonly path: string;
  readonly status: ChunkStatus;
  /** When the attempt finished, ISO UTC. */
  readonly fetched_at: string;
  /** `complete` only. */
  readonly bytes?: number;
  /** `complete` only — hex sha256 of the stored bytes. */
  readonly sha256?: string;
  /** `failed` only — the redacted message, never the URL. */
  readonly error?: string;
}

export interface BackfillManifest {
  readonly manifest_version: number;
  readonly plan: string;
  readonly plan_digest: string;
  readonly area: string;
  readonly polling_bbox_version: string;
  readonly chunks: Readonly<Record<string, ManifestEntry>>;
}

export function emptyManifest(job: BackfillJob): BackfillManifest {
  return {
    manifest_version: MANIFEST_VERSION,
    plan: job.plan,
    plan_digest: job.planDigest,
    area: job.area,
    polling_bbox_version: job.pollingBboxVersion,
    chunks: {},
  };
}

export function withEntry(
  manifest: BackfillManifest,
  chunkId: string,
  entry: ManifestEntry,
): BackfillManifest {
  return { ...manifest, chunks: { ...manifest.chunks, [chunkId]: entry } };
}

/**
 * The entry that lets a chunk be skipped, or `null` when it must be (re-)downloaded.
 * Status alone is not enough: the file also has to still be at the recorded path — an
 * archive restored from a partial copy has complete entries whose files are gone.
 */
export function completedEntry(
  manifest: BackfillManifest,
  chunk: BackfillChunk,
): ManifestEntry | null {
  const entry = manifest.chunks[chunk.chunkId];
  if (entry === undefined || entry.status !== 'complete') return null;
  return entry;
}

/** Pretty-printed, keys sorted at every depth — diffable and readable in a terminal. */
export function renderManifest(manifest: BackfillManifest): string {
  return `${JSON.stringify(sortKeysDeep(manifest), null, 2)}\n`;
}

/**
 * Parses and *matches* the manifest against the job. A manifest written under a different
 * plan, digest or area is refused by name: resuming across such a change would mix
 * spatially or temporally different windows into one corpus, and the bias would be
 * invisible in the files themselves (DATA-SOURCES §A9 — narrowing is a data-loss event).
 */
export function parseManifest(text: string, job: BackfillJob): BackfillManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `the backfill manifest is not valid JSON (${describe(error)}); ` +
        'restore it from the archive copy rather than deleting it — deleting forgets every hash',
      { cause: error },
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the backfill manifest must be a JSON object');
  }
  const record = raw as Record<string, unknown>;

  if (record['manifest_version'] !== MANIFEST_VERSION) {
    throw new Error(
      `unsupported manifest_version ${JSON.stringify(record['manifest_version'])}; ` +
        `this build writes version ${String(MANIFEST_VERSION)}`,
    );
  }
  for (const [field, expected] of [
    ['plan', job.plan],
    ['plan_digest', job.planDigest],
    ['area', job.area],
    ['polling_bbox_version', job.pollingBboxVersion],
  ] as const) {
    if (record[field] !== expected) {
      throw new Error(
        `manifest ${field} is ${JSON.stringify(record[field])} but this run is ` +
          `${JSON.stringify(expected)}; a changed plan or area needs a fresh archive ` +
          'directory, not a resume over a differently-shaped one',
      );
    }
  }

  const chunksRaw = record['chunks'];
  if (chunksRaw === null || typeof chunksRaw !== 'object' || Array.isArray(chunksRaw)) {
    throw new Error('manifest chunks must be an object keyed by chunk id');
  }
  const chunks: Record<string, ManifestEntry> = {};
  for (const [chunkId, value] of Object.entries(chunksRaw)) {
    chunks[chunkId] = parseEntry(chunkId, value);
  }

  return {
    manifest_version: MANIFEST_VERSION,
    plan: job.plan,
    plan_digest: job.planDigest,
    area: job.area,
    polling_bbox_version: job.pollingBboxVersion,
    chunks,
  };
}

function parseEntry(chunkId: string, value: unknown): ManifestEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`manifest entry ${JSON.stringify(chunkId)} is not an object`);
  }
  const entry = value as Record<string, unknown>;
  const status = entry['status'];
  if (status !== 'complete' && status !== 'failed') {
    throw new Error(
      `manifest entry ${JSON.stringify(chunkId)} has status ${JSON.stringify(status)}; ` +
        'only "complete" and "failed" exist — "in progress" is deliberately unrepresentable',
    );
  }
  const str = (field: string): string => {
    const v = entry[field];
    if (typeof v !== 'string') {
      throw new Error(`manifest entry ${JSON.stringify(chunkId)} needs string ${field}`);
    }
    return v;
  };
  const base = {
    source: str('source'),
    product: str('product'),
    start_date: str('start_date'),
    day_range: num(chunkId, entry, 'day_range'),
    path: str('path'),
    fetched_at: str('fetched_at'),
  };
  if (status === 'complete') {
    if (typeof entry['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(entry['sha256'])) {
      throw new Error(
        `manifest entry ${JSON.stringify(chunkId)} is complete but carries no hex sha256 — ` +
          'without the hash, --check has nothing to verify against',
      );
    }
    return { ...base, status, bytes: num(chunkId, entry, 'bytes'), sha256: entry['sha256'] };
  }
  return typeof entry['error'] === 'string'
    ? { ...base, status, error: entry['error'] }
    : { ...base, status };
}

function num(chunkId: string, entry: Record<string, unknown>, field: string): number {
  const v = entry[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`manifest entry ${JSON.stringify(chunkId)} needs numeric ${field}`);
  }
  return v;
}

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => [key, sortKeysDeep(member)]),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
