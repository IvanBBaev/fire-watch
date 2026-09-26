/**
 * Configuration and argument parsing for the zone-centre key rotation CLI (TASKS I2). In
 * its own module, away from the CLI entrypoint, so tests can exercise the parsing without
 * importing a file whose top level runs `main()`.
 *
 * Environment:
 *
 *   * DATABASE_URL — required.
 *   * FIRE_WATCH_DB_ROLE — optional, defaulting to `fire_watch_app` (which holds UPDATE on
 *     `watch_zones`), validated as a bare identifier.
 *   * FIRE_WATCH_ZONE_KEY_ID + FIRE_WATCH_ZONE_KEY, FIRE_WATCH_ZONE_KEYS_RETIRED — the
 *     keyring, read by `zones-config.ts` exactly as the API reads it, and **required**
 *     here: the job opens under the retired keys and seals under the active one. Run it
 *     with the same keyring the API has after the new key was made active.
 *
 * Arguments, all optional:
 *
 *   * `--batch-size=N` — rows per batch and per transaction, 1–10000 (default 100).
 *   * `--max-batches=N` — stop after N batches; the next run carries on (default: none).
 *   * `--dry-run` — open every row under an old key, write nothing.
 */

import type { ZoneKeyring } from '../adapters/crypto/aes-gcm-zone-cipher.js';
import type { ZoneKeyRotationReport } from '../core/zones/rotate-zone-centre-keys.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';
import { describeZonesConfig, loadZonesConfig } from './zones-config.js';

const DEFAULT_DATABASE_ROLE = 'fire_watch_app';
export const DEFAULT_ROTATION_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 10_000;

export interface ZoneKeyRotationConfig {
  readonly databaseUrl: string;
  readonly databaseRole: string;
  readonly keyring: ZoneKeyring;
}

export interface ZoneKeyRotationArgs {
  readonly batchSize: number;
  readonly maxBatches: number | null;
  readonly dryRun: boolean;
}

export function loadZoneKeyRotationConfig(env: Environment): ZoneKeyRotationConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new ConfigError('missing required environment variable(s): DATABASE_URL');
  }
  const keyring = loadZonesConfig(env);
  if (keyring === null) {
    throw new ConfigError(
      'missing required environment variable(s): FIRE_WATCH_ZONE_KEY_ID, FIRE_WATCH_ZONE_KEY',
    );
  }
  return { databaseUrl, databaseRole: readRole(env['FIRE_WATCH_DB_ROLE']?.trim()), keyring };
}

// Same rule as app/config.ts's unexported `readRole`.
function readRole(role: string | undefined): string {
  if (role === undefined || role === '') return DEFAULT_DATABASE_ROLE;
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new ConfigError(
      `FIRE_WATCH_DB_ROLE must be a lowercase unquoted identifier, got ${JSON.stringify(role)}`,
    );
  }
  return role;
}

const USAGE = 'usage: zone-key-rotation-cli [--batch-size=N] [--max-batches=N] [--dry-run]';

export function parseZoneKeyRotationArgs(args: readonly string[]): ZoneKeyRotationArgs {
  let batchSize: number | null = null;
  let maxBatches: number | null = null;
  let dryRun = false;
  for (const arg of args) {
    if (arg.startsWith('--batch-size=')) {
      if (batchSize !== null) throw new ConfigError(`--batch-size given more than once. ${USAGE}`);
      batchSize = positiveInt(arg.slice('--batch-size='.length), '--batch-size', MAX_BATCH_SIZE);
    } else if (arg.startsWith('--max-batches=')) {
      if (maxBatches !== null)
        throw new ConfigError(`--max-batches given more than once. ${USAGE}`);
      maxBatches = positiveInt(arg.slice('--max-batches='.length), '--max-batches', null);
    } else if (arg === '--dry-run') {
      if (dryRun) throw new ConfigError(`--dry-run given more than once. ${USAGE}`);
      dryRun = true;
    } else {
      throw new ConfigError(`unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }
  return { batchSize: batchSize ?? DEFAULT_ROTATION_BATCH_SIZE, maxBatches, dryRun };
}

function positiveInt(text: string, flag: string, max: number | null): number {
  const value = /^[1-9][0-9]{0,8}$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isNaN(value) || (max !== null && value > max)) {
    const range = max === null ? 'a positive integer' : `an integer from 1 to ${String(max)}`;
    throw new ConfigError(`${flag} must be ${range}. ${USAGE}`);
  }
  return value;
}

/**
 * The CLI's exit code for a finished run: 0 complete; 1 rows that could not be opened
 * remain; 3 incomplete but clean (batch cap, dry run, or a raced row) — run again.
 */
export function zoneKeyRotationExitCode(report: ZoneKeyRotationReport): number {
  if (Object.keys(report.failedByKeyId).length > 0) return 1;
  return report.complete ? 0 : 3;
}

/** Safe to print: the password never leaves the URL object, and keys never leave the keyring. */
export function describeZoneKeyRotationConfig(
  config: ZoneKeyRotationConfig,
): Record<string, unknown> {
  return {
    database: redactUrl(config.databaseUrl),
    database_role: config.databaseRole,
    ...describeZonesConfig(config.keyring),
  };
}

// Local copy of app/config.ts's unexported helper (same behavior, verbatim rules).
function redactUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return '<unparseable DATABASE_URL>';
  }
  const user = url.username === '' ? '' : `${url.username}@`;
  return `${url.protocol}//${user}${url.host}${url.pathname}`;
}
