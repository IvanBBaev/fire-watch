/**
 * Configuration and argument parsing for the NRT-lag histogram CLI (TASKS C9). In its own
 * module, away from the CLI entrypoint, so tests can exercise the parsing without
 * importing a file whose top level runs `main()`.
 *
 * Two environment variables, the same pair as the parity check's:
 *
 *   * DATABASE_URL — required.
 *   * FIRE_WATCH_DB_ROLE — optional, defaulting to `fire_watch_app` (which holds INSERT and
 *     UPDATE on `nrt_lag_histograms`), validated as a bare identifier.
 *
 * No FIRMS_MAP_KEY: both commands work from rows already in `detections`.
 *
 * Two commands:
 *
 *   * `record [--day=YYYY-MM-DD]...` — recompute and persist the named UTC days (default:
 *     yesterday and today, exactly what the worker loop does). Repeating `--day` is how a
 *     range is backfilled after the migration lands on a database that already has rows.
 *   * `export --from=YYYY-MM-DD --to=YYYY-MM-DD` — print the `availability.json` profile
 *     merged over the inclusive day window, from persisted rows only.
 */

import { utcDayStartMs } from '../core/ingest/lag-histogram.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

const DEFAULT_DATABASE_ROLE = 'fire_watch_app';

export interface LagHistogramConfig {
  readonly databaseUrl: string;
  readonly databaseRole: string;
}

export type LagHistogramCommand =
  /** `days` is null for the default (yesterday and today); otherwise sorted, distinct. */
  | { readonly kind: 'record'; readonly days: readonly string[] | null }
  | { readonly kind: 'export'; readonly fromDay: string; readonly toDay: string };

export function loadLagHistogramConfig(env: Environment): LagHistogramConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new ConfigError('missing required environment variable(s): DATABASE_URL');
  }
  return { databaseUrl, databaseRole: readRole(env['FIRE_WATCH_DB_ROLE']?.trim()) };
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

const USAGE =
  'usage: lag-histogram-cli record [--day=YYYY-MM-DD]... | ' +
  'lag-histogram-cli export --from=YYYY-MM-DD --to=YYYY-MM-DD';

export function parseLagHistogramArgs(args: readonly string[]): LagHistogramCommand {
  const [command, ...rest] = args;
  if (command === 'record') return parseRecord(rest);
  if (command === 'export') return parseExport(rest);
  throw new ConfigError(
    `${command === undefined ? 'a command is required' : `unknown command ${JSON.stringify(command)}`}. ${USAGE}`,
  );
}

function parseRecord(args: readonly string[]): LagHistogramCommand {
  const days = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith('--day=')) {
      throw new ConfigError(`unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
    }
    days.add(validDay(arg.slice('--day='.length), '--day'));
  }
  return { kind: 'record', days: days.size === 0 ? null : [...days].sort() };
}

function parseExport(args: readonly string[]): LagHistogramCommand {
  let from: string | null = null;
  let to: string | null = null;
  for (const arg of args) {
    if (arg.startsWith('--from=')) {
      if (from !== null) throw new ConfigError(`--from given more than once. ${USAGE}`);
      from = validDay(arg.slice('--from='.length), '--from');
    } else if (arg.startsWith('--to=')) {
      if (to !== null) throw new ConfigError(`--to given more than once. ${USAGE}`);
      to = validDay(arg.slice('--to='.length), '--to');
    } else {
      throw new ConfigError(`unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }
  if (from === null || to === null) {
    throw new ConfigError(`export needs both --from and --to. ${USAGE}`);
  }
  if (to < from) throw new ConfigError(`--to is before --from. ${USAGE}`);
  return { kind: 'export', fromDay: from, toDay: to };
}

function validDay(day: string, flag: string): string {
  try {
    utcDayStartMs(day);
  } catch (error) {
    throw new ConfigError(
      `${flag}: ${error instanceof Error ? error.message : String(error)}. ${USAGE}`,
    );
  }
  return day;
}

/** Safe to print: the password never leaves the URL object. */
export function describeLagHistogramConfig(config: LagHistogramConfig): Record<string, string> {
  return {
    database: redactUrl(config.databaseUrl),
    database_role: config.databaseRole,
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
