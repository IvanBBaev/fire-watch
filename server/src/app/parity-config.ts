/**
 * Configuration and argument parsing for the ingestion-parity CLI (TASKS C9). In its own
 * module, away from the CLI entrypoint, so tests can exercise the parsing without
 * importing a file whose top level runs `main()`.
 *
 * Two environment variables:
 *
 *   * DATABASE_URL — required. The check only reads, so the runtime role is enough.
 *   * FIRE_WATCH_DB_ROLE — optional, defaulting to `fire_watch_app`, validated by the same
 *     bare-identifier rule as the worker's (it travels as a startup option).
 *
 * No FIRMS_MAP_KEY: the reference is a file an operator exported from the FIRMS map, one
 * per source, named on the command line. Fetching it here would make the check depend on
 * the same client whose output it is checking.
 *
 * The window is whole UTC days, `[from 00:00Z, to + 1 day 00:00Z)` — the FIRMS map exports
 * by date, and a UTC day is the choice that needs no calendar and cannot be 23 or 25 hours
 * long.
 */

import { isAbsolute } from 'node:path';

import { isSourceId, type SourceId } from '@fire-watch/contracts';

import type { ParityWindow } from '../core/ingest/parity-check.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

const DEFAULT_DATABASE_ROLE = 'fire_watch_app';

const DAY_MS = 86_400_000;

export interface ParityConfig {
  readonly databaseUrl: string;
  readonly databaseRole: string;
}

export interface ParityReferenceFile {
  readonly source: SourceId;
  /** Absolute path to a FIRMS CSV export for exactly this source. */
  readonly path: string;
}

export interface ParityOptions {
  readonly fromDay: string;
  readonly toDay: string;
  readonly window: ParityWindow;
  /** Sorted by source; one per source. */
  readonly references: readonly ParityReferenceFile[];
}

export function loadParityConfig(env: Environment): ParityConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new ConfigError('missing required environment variable(s): DATABASE_URL');
  }
  return { databaseUrl, databaseRole: readRole(env['FIRE_WATCH_DB_ROLE']?.trim()) };
}

// Same rule as app/config.ts's unexported `readRole`: the role reaches Postgres as a
// connection startup option, so anything but a bare identifier is refused.
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
  'usage: parity-cli (--day=YYYY-MM-DD | --from=YYYY-MM-DD --to=YYYY-MM-DD) ' +
  '--reference=<source_id>=/abs/path.csv [--reference=...]';

/** Strict on purpose: a report that says "we ingest what FIRMS publishes" does not guess. */
export function parseParityArgs(args: readonly string[]): ParityOptions {
  let day: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  const references = new Map<SourceId, string>();

  const once = (current: string | null, flag: string, value: string): string => {
    if (current !== null) throw new ConfigError(`${flag} given more than once. ${USAGE}`);
    return value;
  };

  for (const arg of args) {
    if (arg.startsWith('--day=')) {
      day = once(day, '--day', arg.slice('--day='.length));
    } else if (arg.startsWith('--from=')) {
      from = once(from, '--from', arg.slice('--from='.length));
    } else if (arg.startsWith('--to=')) {
      to = once(to, '--to', arg.slice('--to='.length));
    } else if (arg.startsWith('--reference=')) {
      const reference = parseReference(arg.slice('--reference='.length));
      if (references.has(reference.source)) {
        throw new ConfigError(`--reference for ${reference.source} given more than once`);
      }
      references.set(reference.source, reference.path);
    } else {
      throw new ConfigError(`unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }

  if (day !== null && (from !== null || to !== null)) {
    throw new ConfigError(`--day excludes --from/--to. ${USAGE}`);
  }
  const fromDay = day ?? from;
  const toDay = day ?? to;
  if (fromDay === null || toDay === null) {
    throw new ConfigError(`--day, or both --from and --to, are required. ${USAGE}`);
  }
  const fromMs = utcDayStart(fromDay, day === null ? '--from' : '--day');
  const toMs = utcDayStart(toDay, day === null ? '--to' : '--day') + DAY_MS;
  if (toMs <= fromMs) throw new ConfigError(`--to is before --from. ${USAGE}`);
  if (references.size === 0)
    throw new ConfigError(`at least one --reference is required. ${USAGE}`);

  return {
    fromDay,
    toDay,
    window: { fromMs, toMs },
    references: [...references.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([source, path]) => ({ source, path })),
  };
}

/**
 * `<source_id>=<path>`. Split on the first `=` after the source id: ids contain `:` but
 * never `=`, and a path may contain either.
 */
function parseReference(value: string): ParityReferenceFile {
  const at = value.indexOf('=');
  if (at <= 0) {
    throw new ConfigError(
      `--reference must be <source_id>=/abs/path.csv, got ${JSON.stringify(value)}. ${USAGE}`,
    );
  }
  const source = value.slice(0, at);
  const path = value.slice(at + 1);
  if (!isSourceId(source)) {
    throw new ConfigError(`--reference names an unknown source ${JSON.stringify(source)}`);
  }
  if (!source.startsWith('firms:')) {
    throw new ConfigError(
      `--reference must name a FIRMS source (the reference is a FIRMS export), got ${source}`,
    );
  }
  if (!isAbsolute(path)) {
    throw new ConfigError(`--reference path must be absolute, got ${JSON.stringify(path)}`);
  }
  return { source, path };
}

/** A date that does not exist is refused, not rolled over. */
function utcDayStart(day: string, flag: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new ConfigError(`${flag} must be YYYY-MM-DD, got ${JSON.stringify(day)}. ${USAGE}`);
  }
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const fromMs = Date.UTC(year, month - 1, date);
  const check = new Date(fromMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== date
  ) {
    throw new ConfigError(`${flag} is not a calendar date: ${JSON.stringify(day)}. ${USAGE}`);
  }
  return fromMs;
}

/** Safe to print: the password never leaves the URL object. */
export function describeParityConfig(config: ParityConfig): Record<string, string> {
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
    // Unparseable is still not printable: it may be a DSN with `password=` in it.
    return '<unparseable DATABASE_URL>';
  }
  const user = url.username === '' ? '' : `${url.username}@`;
  return `${url.protocol}//${user}${url.host}${url.pathname}`;
}
