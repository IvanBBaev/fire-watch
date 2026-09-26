/**
 * Configuration for the backfill CLI (TASKS B8), read from the environment and nowhere
 * else — same contract as `config.ts`, minus everything the backfill does not need. No
 * database: the job downloads raw CSVs to a disk, and ingesting them is a later task.
 *
 * Missing variables are reported by name, all at once, and the map key is never written
 * into a message — the rules are `config.ts`'s, restated here only because this loader
 * has its own required set.
 */

import { isAbsolute } from 'node:path';

import { ConfigError, readBaseUrl, type Environment } from './config.js';

export interface BackfillConfig {
  /** The FIRMS Area API key. Travels as a URL path segment — see the client adapter. */
  readonly firmsMapKey: string;
  /** Same override as the worker's, and the same variable: `FIRMS_BASE_URL`. */
  readonly firmsBaseUrl: string;
  /** Absolute path to the archive root; the manifest and every CSV live under it. */
  readonly archiveDir: string;
  /** Politeness pause between consecutive requests. */
  readonly requestDelayMs: number;
}

/**
 * 5 seconds. 666 requests at this pace is ~70 minutes for the whole 2020–2025 corpus —
 * slow enough to be unremarkable in FIRMS's logs, fast enough to finish in one sitting.
 * The quota (5,000 transactions / 10 min) is never the binding constraint at any
 * permitted setting; the bounds exist so a typo cannot turn politeness into a hammer
 * (below 1 s) or a week-long job (above 10 min).
 */
export const DEFAULT_BACKFILL_DELAY_MS = 5_000;

const MIN_BACKFILL_DELAY_MS = 1_000;
const MAX_BACKFILL_DELAY_MS = 600_000;

export function loadBackfillConfig(env: Environment): BackfillConfig {
  const missing: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  };

  const firmsMapKey = required('FIRMS_MAP_KEY');
  const archiveDir = required('FIRE_WATCH_ARCHIVE_DIR');

  if (missing.length > 0) {
    throw new ConfigError(
      `missing required environment variable(s): ${missing.join(', ')}. ` +
        'FIRE_WATCH_ARCHIVE_DIR is the local directory the raw CSV archive is written to.',
    );
  }

  // Relative would resolve against whatever directory the operator happened to run from,
  // and "where did my archive go" is not a question a 70-minute job should raise.
  if (!isAbsolute(archiveDir)) {
    throw new ConfigError(
      `FIRE_WATCH_ARCHIVE_DIR must be an absolute path, got ${JSON.stringify(archiveDir)}`,
    );
  }

  return {
    firmsMapKey,
    firmsBaseUrl: readBaseUrl(env['FIRMS_BASE_URL']?.trim()),
    archiveDir,
    requestDelayMs: readDelay(env['FIRE_WATCH_BACKFILL_DELAY_MS']?.trim()),
  };
}

function readDelay(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_BACKFILL_DELAY_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < MIN_BACKFILL_DELAY_MS || ms > MAX_BACKFILL_DELAY_MS) {
    throw new ConfigError(
      `FIRE_WATCH_BACKFILL_DELAY_MS must be an integer between ${String(MIN_BACKFILL_DELAY_MS)} ` +
        `and ${String(MAX_BACKFILL_DELAY_MS)} ms, got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

/** A description safe to log — the key by length only, same convention as `describeConfig`. */
export function describeBackfillConfig(config: BackfillConfig): Record<string, string> {
  return {
    firms_map_key: `<${String(config.firmsMapKey.length)} characters>`,
    firms_base_url: config.firmsBaseUrl,
    archive_dir: config.archiveDir,
    request_delay_ms: String(config.requestDelayMs),
  };
}
