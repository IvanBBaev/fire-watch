/**
 * Configuration and argument parsing for the shadow-diff CLI (TASKS H8). In its own
 * module, away from the CLI entrypoint, so tests can exercise the parsing without
 * importing a file whose top level runs `main()`.
 *
 * Two environment variables:
 *
 *   * DATABASE_URL — required. The diff only reads, so the runtime role is enough.
 *   * FIRE_WATCH_DB_ROLE — optional, defaulting to `fire_watch_app`, validated by the same
 *     bare-identifier rule as the worker's (it travels as a startup option).
 *
 * The window is one UTC calendar day, `[00:00Z, 24:00Z)`. Whether the nightly run should
 * instead cover a Europe/Sofia day is a founder decision (see the report on H8); a UTC day
 * is the choice that needs no calendar and cannot be 23 or 25 hours long.
 */

import { isAbsolute } from 'node:path';

import type { ShadowWindow } from '../core/shadow/shadow-diff.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

const DEFAULT_DATABASE_ROLE = 'fire_watch_app';

/** Migration 006's CHECK on `candidate_version`, so a typo fails here, not as zero rows. */
const CANDIDATE_VERSION = /^[a-z0-9_]+_v[0-9]+$/;

const DAY_MS = 86_400_000;

export interface ShadowDiffConfig {
  readonly databaseUrl: string;
  readonly databaseRole: string;
}

export interface ShadowDiffOptions {
  readonly candidateVersion: string;
  readonly day: string;
  readonly window: ShadowWindow;
  /** Absolute path to the explanations document, or null for "nothing explained yet". */
  readonly explanationsPath: string | null;
}

export function loadShadowDiffConfig(env: Environment): ShadowDiffConfig {
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
  'usage: shadow-diff-cli --candidate=<config_version> --day=YYYY-MM-DD [--explanations=/abs/path.json]';

/** Strict on purpose: a report that gates promotion does not guess at a misspelt flag. */
export function parseShadowDiffArgs(args: readonly string[]): ShadowDiffOptions {
  let candidateVersion: string | null = null;
  let day: string | null = null;
  let explanationsPath: string | null = null;

  const once = (current: string | null, flag: string, value: string): string => {
    if (current !== null) throw new ConfigError(`${flag} given more than once. ${USAGE}`);
    return value;
  };

  for (const arg of args) {
    if (arg.startsWith('--candidate=')) {
      candidateVersion = once(candidateVersion, '--candidate', arg.slice('--candidate='.length));
    } else if (arg.startsWith('--day=')) {
      day = once(day, '--day', arg.slice('--day='.length));
    } else if (arg.startsWith('--explanations=')) {
      explanationsPath = once(
        explanationsPath,
        '--explanations',
        arg.slice('--explanations='.length),
      );
    } else {
      throw new ConfigError(`unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }

  if (candidateVersion === null) throw new ConfigError(`--candidate is required. ${USAGE}`);
  if (!CANDIDATE_VERSION.test(candidateVersion)) {
    throw new ConfigError(
      `--candidate must look like <name>_v<N>, got ${JSON.stringify(candidateVersion)}. ${USAGE}`,
    );
  }
  if (day === null) throw new ConfigError(`--day is required. ${USAGE}`);
  if (explanationsPath !== null && !isAbsolute(explanationsPath)) {
    throw new ConfigError(
      `--explanations must be an absolute path, got ${JSON.stringify(explanationsPath)}`,
    );
  }

  return { candidateVersion, day, window: utcDayWindow(day), explanationsPath };
}

/** `[day 00:00Z, next day 00:00Z)`. A date that does not exist is refused, not rolled over. */
export function utcDayWindow(day: string): ShadowWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new ConfigError(`--day must be YYYY-MM-DD, got ${JSON.stringify(day)}. ${USAGE}`);
  }
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const fromMs = Date.UTC(year, month - 1, date);
  const check = new Date(fromMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== date
  ) {
    throw new ConfigError(`--day is not a calendar date: ${JSON.stringify(day)}. ${USAGE}`);
  }
  return { fromMs, toMs: fromMs + DAY_MS };
}

/** Safe to print: the password never leaves the URL object. */
export function describeShadowDiffConfig(config: ShadowDiffConfig): Record<string, string> {
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
