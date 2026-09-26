/**
 * Freshness bookkeeping on disk for the rows `source_status` cannot hold (TASKS C4).
 *
 * `source_status.source` FKs into the frozen `sources` registry, so the unregistered
 * feeds (`effis:layers`, `weather:context`) and the budgeted jobs need their own home.
 * One small JSON file per row under `<root>/feed-status/`, written atomically — the
 * same shape of answer the Postgres reader gives for source rows, so the health
 * endpoint can merge the two without knowing which store answered.
 *
 * Asymmetric corruption handling, on purpose:
 *
 *   * `recordAttempt` treats an unreadable file as absent and rewrites it — the writer
 *     self-heals, because refusing to record attempts over a corrupt file would freeze
 *     the freshness page at the moment of the corruption, forever.
 *   * `readObservations` throws, naming the file — the reader must never render a
 *     corrupt store as a fleet of healthy-looking unknowns (the port's contract: a
 *     store error is a 500 with a reason, not an empty result).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { isMonitoredFeedId, isMonitoredSourceId, type FreshnessRowId } from '@fire-watch/contracts';

import { canonicalJson } from '../../core/determinism/canonical-json.js';
import type { FreshnessObservation } from '../../core/health/freshness.js';
import type {
  FeedAttempt,
  FeedStatusStore,
  RecordableRowId,
} from '../../core/ports/feed-status-store.js';
import type { FreshnessReader } from '../../core/ports/freshness-reader.js';

export const FEED_STATUS_DIR = 'feed-status';

interface PersistedStatus {
  readonly row: string;
  readonly last_attempt_at: number | null;
  readonly last_success_at: number | null;
  readonly last_data_at: number | null;
  readonly consecutive_failures: number;
  readonly last_error: string | null;
}

export function createFsFeedStatusStore(rootDir: string): FeedStatusStore & FreshnessReader {
  if (!isAbsolute(rootDir)) {
    throw new RangeError(
      `feed status root must be an absolute path, got ${JSON.stringify(rootDir)}`,
    );
  }
  const root = resolve(rootDir);

  const fileFor = (row: RecordableRowId): string => {
    // ':' is untrustworthy in filenames (ADS on Windows, awkward in shells); the ids
    // contain no '-'-vs-':' collisions, so a plain substitution stays reversible enough.
    const target = join(root, FEED_STATUS_DIR, `${row.replaceAll(':', '-')}.json`);
    const within = relative(root, target);
    if (within === '' || within.startsWith('..') || isAbsolute(within)) {
      throw new RangeError(`feed status path escapes the root: ${JSON.stringify(row)}`);
    }
    return target;
  };

  const readStatus = async (
    row: RecordableRowId,
  ): Promise<{ status: PersistedStatus | null; corrupt: string | null }> => {
    let raw: string;
    try {
      raw = await readFile(fileFor(row), 'utf8');
    } catch (error) {
      if (isEnoent(error)) return { status: null, corrupt: null };
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const status = toPersisted(parsed);
      if (status === null) return { status: null, corrupt: `malformed status in ${fileFor(row)}` };
      return { status, corrupt: null };
    } catch {
      return { status: null, corrupt: `unparseable status in ${fileFor(row)}` };
    }
  };

  return {
    async recordAttempt(attempt: FeedAttempt): Promise<void> {
      const existing = (await readStatus(attempt.row)).status;
      const next: PersistedStatus = {
        row: attempt.row,
        last_attempt_at: attempt.attemptAt,
        last_success_at: attempt.succeeded
          ? attempt.attemptAt
          : (existing?.last_success_at ?? null),
        last_data_at: attempt.hadData ? attempt.attemptAt : (existing?.last_data_at ?? null),
        consecutive_failures: attempt.succeeded ? 0 : (existing?.consecutive_failures ?? 0) + 1,
        last_error: attempt.error,
      };
      const target = fileFor(attempt.row);
      await mkdir(dirname(target), { recursive: true });
      const partial = `${target}.partial`;
      await writeFile(partial, `${canonicalJson(next)}\n`, 'utf8');
      await rename(partial, target);
    },

    async readObservations(
      rows: readonly FreshnessRowId[],
    ): Promise<readonly FreshnessObservation[]> {
      const observations: FreshnessObservation[] = [];
      for (const row of rows) {
        // Registered source rows belong to the Postgres reader; answering for them here
        // would double-report them when the two readers are combined.
        if (isMonitoredFeedId(row) && isMonitoredSourceId(row)) continue;
        const { status, corrupt } = await readStatus(row);
        if (corrupt !== null) throw new Error(corrupt);
        if (status === null) continue;
        observations.push({
          row,
          lastAttemptAt: status.last_attempt_at,
          lastSuccessAt: status.last_success_at,
          lastDataAt: status.last_data_at,
          consecutiveFailures: status.consecutive_failures,
        });
      }
      return observations;
    },
  };
}

function toPersisted(value: unknown): PersistedStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const row = candidate['row'];
  const lastAttemptAt = candidate['last_attempt_at'];
  const lastSuccessAt = candidate['last_success_at'];
  const lastDataAt = candidate['last_data_at'];
  const consecutiveFailures = candidate['consecutive_failures'];
  const lastError = candidate['last_error'];
  if (typeof row !== 'string') return null;
  if (!isEpochOrNull(lastAttemptAt) || !isEpochOrNull(lastSuccessAt) || !isEpochOrNull(lastDataAt))
    return null;
  if (typeof consecutiveFailures !== 'number' || !Number.isSafeInteger(consecutiveFailures))
    return null;
  if (lastError !== null && typeof lastError !== 'string') return null;
  return {
    row,
    last_attempt_at: lastAttemptAt,
    last_success_at: lastSuccessAt,
    last_data_at: lastDataAt,
    consecutive_failures: consecutiveFailures,
    last_error: lastError,
  };
}

function isEpochOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
