/**
 * Configuration and argument parsing for the SP promotion CLI (TASKS C7). In its own
 * module, away from the CLI entrypoint, so tests can exercise the parsing without
 * importing a file whose top level runs `main()`.
 *
 * Two environment variables, both required, both fail-fast:
 *
 *   * DATABASE_URL — must log in as the schema owner (the migrations login), not as
 *     `fire_watch_app`: promotion is DDL, and the append-only runtime role cannot
 *     detach or attach a partition. Getting this wrong is loud, not silent.
 *   * FIRE_WATCH_ARCHIVE_DIR — the B8 SP archive root, absolute.
 *
 * No FIRMS_MAP_KEY: promotion reads the archive the backfill already wrote and never
 * talks to FIRMS.
 */

import { isAbsolute } from 'node:path';

import type { PromotionOptions } from '../core/promotion/promotion-run.js';
import { monthWindow } from '../core/promotion/month-window.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

export interface SpPromotionConfig {
  readonly databaseUrl: string;
  readonly archiveDir: string;
}

export function loadSpPromotionConfig(env: Environment): SpPromotionConfig {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  };

  const databaseUrl = required('DATABASE_URL');
  const archiveDir = required('FIRE_WATCH_ARCHIVE_DIR');
  if (missing.length > 0) {
    throw new ConfigError(`missing required environment variable(s): ${missing.join(', ')}`);
  }
  if (!isAbsolute(archiveDir)) {
    throw new ConfigError(
      `FIRE_WATCH_ARCHIVE_DIR must be an absolute path, got ${JSON.stringify(archiveDir)}`,
    );
  }
  return { databaseUrl, archiveDir };
}

const USAGE = 'usage: sp-promotion-cli --month=YYYY-MM [--dry-run] [--confirm]';

/** Strict on purpose: an unknown flag on a partition-swapping CLI is a stop, not a warning. */
export function parsePromotionArgs(args: readonly string[]): PromotionOptions {
  let month: string | null = null;
  let dryRun = false;
  let operatorConfirmed = false;

  for (const arg of args) {
    if (arg.startsWith('--month=')) {
      if (month !== null) {
        throw new ConfigError(`--month given more than once. ${USAGE}`);
      }
      month = arg.slice('--month='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--confirm') {
      operatorConfirmed = true;
    } else {
      throw new ConfigError(`unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }

  if (month === null) {
    throw new ConfigError(`--month is required. ${USAGE}`);
  }
  try {
    monthWindow(month);
  } catch (error) {
    throw new ConfigError(`${error instanceof Error ? error.message : String(error)}. ${USAGE}`);
  }

  return { month, dryRun, operatorConfirmed };
}

/** Safe to print: the password never leaves the URL object. */
export function describeSpPromotionConfig(config: SpPromotionConfig): Record<string, string> {
  return {
    database: redactUrl(config.databaseUrl),
    archive_dir: config.archiveDir,
  };
}

// Local copy of app/config.ts's unexported helper (same behavior, verbatim rules):
// promotion must not widen that module's surface just to log a URL.
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
